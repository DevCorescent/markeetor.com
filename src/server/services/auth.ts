import { audit, auditDetached } from '../audit';
import type { AuthContext, RequestMeta } from '../auth/context';
import { decryptSecret, encryptSecret, matchRecoveryCode, newRecoveryCodes, newTotpSecret, totpProvisioning, verifyTotp } from '../auth/mfa';
import { hashPassword, passwordProblems, verifyPassword } from '../auth/password';
import { createSession, revokeAllSessions } from '../auth/session';
import { randomToken, sha256 } from '../crypto';
import { prisma, withPlatform } from '../db';
import { AppError } from '../errors';
import { sendEmail } from '../mail';
import { rateLimit } from '../ratelimit';
import { redis } from '../redis';
import { onLoginFailure, raiseAlert } from '../security/alerts';
import { getSetting } from '../settings';
import { productName } from '../branding';

const GENERIC = 'Invalid email or password';

function ipAllowed(ip: string | null, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  if (!ip) return false;
  return allowlist.some((entry) => {
    const e = entry.trim();
    if (!e) return false;
    if (e.endsWith('*')) return ip.startsWith(e.slice(0, -1));
    return ip === e;
  });
}

export async function login(input: { email: string; password: string }, meta: RequestMeta) {
  const email = input.email.trim().toLowerCase();
  const policy = await getSetting('security.policy');

  const ipLimit = await rateLimit(`login:ip:${meta.ip ?? 'unknown'}`, 30, 900);
  const emailLimit = await rateLimit(`login:email:${email}`, 10, 900);
  if (!ipLimit.ok || !emailLimit.ok) {
    await prisma.loginEvent.create({ data: { email, success: false, reason: 'rate_limited', ip: meta.ip, userAgent: meta.userAgent } });
    throw new AppError('RATE_LIMITED', 'Too many sign-in attempts. Please wait a few minutes and try again.');
  }

  const user = await prisma.user.findUnique({ where: { email }, include: { membership: { include: { organization: true, role: true } } } });
  const fail = async (reason: string, userId?: string) => {
    await prisma.loginEvent.create({ data: { email, userId, success: false, reason, ip: meta.ip, userAgent: meta.userAgent } });
    await auditDetached({ requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent }, {
      action: 'auth.login.failed', targetType: 'user', targetId: userId ?? null, result: 'FAILURE', reason,
      organizationId: user?.membership?.organizationId ?? null, metadata: { email },
    });
    await onLoginFailure(email, meta.ip);
  };

  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    await fail('locked', user.id);
    throw new AppError('FORBIDDEN', 'This account is temporarily locked after repeated failed attempts. Try again later or reset your password.');
  }

  const ok = await verifyPassword(user?.passwordHash, input.password);
  if (!user || !ok) {
    if (user) {
      const count = user.failedLoginCount + 1;
      const lock = count >= policy.lockoutThreshold;
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: lock ? 0 : count, lockedUntil: lock ? new Date(Date.now() + policy.lockoutMinutes * 60_000) : undefined },
      });
      if (lock) {
        await raiseAlert({
          type: 'ACCOUNT_LOCKED', severity: 'MEDIUM', userId: user.id, organizationId: user.membership?.organizationId, ip: meta.ip,
          title: `Account locked: ${email}`, details: { threshold: policy.lockoutThreshold, minutes: policy.lockoutMinutes },
        });
      }
    }
    await fail(user ? 'bad_password' : 'unknown_email', user?.id);
    throw new AppError('UNAUTHENTICATED', GENERIC);
  }

  if (user.mustChangePassword && user.tempPasswordExpiresAt && user.tempPasswordExpiresAt < new Date()) {
    await fail('temp_password_expired', user.id);
    throw new AppError('FORBIDDEN', 'Your temporary password has expired. Use “Forgot password” to choose a new one.');
  }
  if (user.status !== 'ACTIVE') {
    await fail(`status_${user.status.toLowerCase()}`, user.id);
    throw new AppError('FORBIDDEN', user.status === 'SUSPENDED' ? 'This account is suspended. Contact your administrator.' : GENERIC);
  }
  const org = user.membership?.organization;
  if (user.membership?.role.scope === 'ORGANIZATION') {
    if (!org || org.status !== 'ACTIVE') {
      await fail('org_inactive', user.id);
      throw new AppError('FORBIDDEN', `Your workspace is ${org?.status.toLowerCase() ?? 'unavailable'}. Contact your administrator.`);
    }
    const allowlist = ((org.settings as { security?: { ipAllowlist?: string[] } })?.security?.ipAllowlist ?? []).filter(Boolean);
    if (!ipAllowed(meta.ip, allowlist)) {
      await fail('ip_not_allowed', user.id);
      await raiseAlert({
        type: 'IP_RESTRICTION', severity: 'MEDIUM', userId: user.id, organizationId: org.id, ip: meta.ip,
        title: `Sign-in blocked by IP restriction for ${email}`, dedupeKey: `iprestrict:${user.id}:${meta.ip}:${new Date().toISOString().slice(0, 13)}`,
      });
      throw new AppError('FORBIDDEN', 'Sign-in is not permitted from this network.');
    }
  }
  if (!user.membership) {
    await fail('no_membership', user.id);
    throw new AppError('FORBIDDEN', 'Your account has no workspace access');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: meta.ip },
  });
  const { token, session, maxAgeSec } = await createSession(user.id, { ip: meta.ip, userAgent: meta.userAgent, mfaPending: user.mfaEnabled });
  await prisma.loginEvent.create({ data: { email, userId: user.id, success: true, reason: user.mfaEnabled ? 'password_ok_mfa_pending' : 'ok', ip: meta.ip, userAgent: meta.userAgent } });
  await auditDetached(
    { user: { id: user.id, email: user.email, name: user.name, mfaEnabled: user.mfaEnabled }, role: { id: user.membership.role.id, key: user.membership.role.key, name: user.membership.role.name, rank: 0 }, orgId: user.membership.organizationId, requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent, session: { id: session.id, mfaPending: session.mfaPending, mfaVerifiedAt: null, stepUpAt: null, createdAt: session.createdAt } },
    { action: user.mfaEnabled ? 'auth.login.password_ok' : 'auth.login', targetType: 'session', targetId: session.id },
  );
  return { token, maxAgeSec, mfaRequired: user.mfaEnabled, scope: user.membership.role.scope };
}

/** Completes the second factor. Rotates the session token to prevent fixation. */
export async function verifyMfa(ctx: AuthContext, code: string) {
  if (!ctx.session) throw new AppError('UNAUTHENTICATED', 'Please sign in');
  const lim = await rateLimit(`mfa:${ctx.session.id}`, 6, 300);
  if (!lim.ok) throw new AppError('RATE_LIMITED', 'Too many attempts. Please sign in again.');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (!user.mfaEnabled || !user.mfaSecretEnc) throw new AppError('BAD_REQUEST', 'Two-factor authentication is not enabled');

  let method = 'totp';
  let ok = verifyTotp(decryptSecret(user.mfaSecretEnc), code);
  if (!ok) {
    const used = matchRecoveryCode(user.mfaRecoveryHashes, code);
    if (used) {
      ok = true;
      method = 'recovery_code';
      await prisma.user.update({ where: { id: user.id }, data: { mfaRecoveryHashes: user.mfaRecoveryHashes.filter((h) => h !== used) } });
    }
  }
  if (!ok) {
    await auditDetached(ctx, { action: 'auth.mfa.failed', targetType: 'user', targetId: user.id, result: 'FAILURE' });
    await onLoginFailure(user.email, ctx.ip);
    throw new AppError('UNAUTHENTICATED', 'That code is not valid');
  }
  const token = randomToken(32);
  const now = new Date();
  await prisma.session.update({
    where: { id: ctx.session.id },
    data: { tokenHash: sha256(token), mfaPending: false, mfaVerifiedAt: now, stepUpAt: now },
  });
  await auditDetached(ctx, { action: 'auth.mfa.verified', targetType: 'session', targetId: ctx.session.id, metadata: { method } });
  const policy = await getSetting('security.policy');
  const remaining = Math.max(60, Math.floor(((ctx.session.createdAt.getTime() + policy.sessionAbsoluteHours * 3600_000) - Date.now()) / 1000));
  return { token, maxAgeSec: remaining, method };
}

const ENROLL_KEY = (userId: string) => `mfa:enroll:${userId}`;

export async function startMfaEnrollment(ctx: AuthContext) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (user.mfaEnabled) throw new AppError('CONFLICT', 'Two-factor authentication is already enabled');
  const secret = newTotpSecret();
  await redis().set(ENROLL_KEY(user.id), encryptSecret(secret), 'EX', 600);
  const { uri, qr } = await totpProvisioning(user.email, secret);
  return { secret, uri, qr };
}

export async function confirmMfaEnrollment(ctx: AuthContext, code: string) {
  const enc = await redis().get(ENROLL_KEY(ctx.user.id));
  if (!enc) throw new AppError('PRECONDITION_FAILED', 'Enrollment expired. Start again.');
  const secret = decryptSecret(enc);
  if (!verifyTotp(secret, code)) throw new AppError('VALIDATION_FAILED', 'That code is not valid. Check your device clock and try again.');
  const { codes, hashes } = newRecoveryCodes();
  await prisma.user.update({ where: { id: ctx.user.id }, data: { mfaEnabled: true, mfaSecretEnc: encryptSecret(secret), mfaRecoveryHashes: hashes } });
  if (ctx.session) await prisma.session.update({ where: { id: ctx.session.id }, data: { mfaVerifiedAt: new Date(), stepUpAt: new Date() } });
  await redis().del(ENROLL_KEY(ctx.user.id));
  await auditDetached(ctx, { action: 'auth.mfa.enrolled', targetType: 'user', targetId: ctx.user.id });
  return { recoveryCodes: codes };
}

export async function disableMfa(ctx: AuthContext, code: string) {
  if (ctx.scope === 'PLATFORM' && (await getSetting('security.policy')).mfaRequiredForPlatform) {
    throw new AppError('FORBIDDEN', 'Platform policy requires two-factor authentication');
  }
  const orgRequired = (ctx.org?.settings as { security?: { mfaRequired?: boolean } } | null)?.security?.mfaRequired;
  if (orgRequired) throw new AppError('FORBIDDEN', 'Your workspace requires two-factor authentication');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (!user.mfaEnabled || !user.mfaSecretEnc || !verifyTotp(decryptSecret(user.mfaSecretEnc), code)) {
    throw new AppError('VALIDATION_FAILED', 'That code is not valid');
  }
  await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: [] } });
  await auditDetached(ctx, { action: 'auth.mfa.disabled', targetType: 'user', targetId: user.id });
}

/** Re-verifies identity for sensitive actions (exports, rollbacks, privileged role changes). */
export async function stepUp(ctx: AuthContext, input: { password?: string; code?: string }) {
  if (!ctx.session) throw new AppError('UNAUTHENTICATED', 'Please sign in');
  const lim = await rateLimit(`stepup:${ctx.user.id}`, 8, 600);
  if (!lim.ok) throw new AppError('RATE_LIMITED', 'Too many attempts. Try again later.');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  let ok = false;
  if (user.mfaEnabled && user.mfaSecretEnc) {
    ok = Boolean(input.code) && verifyTotp(decryptSecret(user.mfaSecretEnc), input.code!);
  } else {
    ok = Boolean(input.password) && (await verifyPassword(user.passwordHash, input.password!));
  }
  if (!ok) {
    await auditDetached(ctx, { action: 'auth.stepup.failed', targetType: 'user', targetId: user.id, result: 'FAILURE' });
    throw new AppError('UNAUTHENTICATED', user.mfaEnabled ? 'That code is not valid' : 'Incorrect password');
  }
  await prisma.session.update({ where: { id: ctx.session.id }, data: { stepUpAt: new Date() } });
  await auditDetached(ctx, { action: 'auth.stepup', targetType: 'session', targetId: ctx.session.id });
  return { method: user.mfaEnabled ? 'totp' : 'password' };
}

export async function changePassword(ctx: AuthContext, current: string, next: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (!(await verifyPassword(user.passwordHash, current))) throw new AppError('VALIDATION_FAILED', 'Current password is incorrect');
  if (current === next) throw new AppError('VALIDATION_FAILED', 'Choose a password that is different from your current one');
  const policy = await getSetting('security.policy');
  const problems = passwordProblems(next, policy.passwordMinLength, [user.email, user.name]);
  if (problems.length) throw new AppError('VALIDATION_FAILED', problems[0], problems);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next), passwordChangedAt: new Date(), mustChangePassword: false, tempPasswordExpiresAt: null } });
  const revoked = await revokeAllSessions(user.id, 'password_changed', ctx.session?.id);
  await auditDetached(ctx, { action: 'auth.password.changed', targetType: 'user', targetId: user.id, metadata: { otherSessionsRevoked: revoked } });
}

export async function requestPasswordReset(emailRaw: string, meta: RequestMeta) {
  const email = emailRaw.trim().toLowerCase();
  const lim = await rateLimit(`pwreset:${email}`, 3, 3600);
  const ipLim = await rateLimit(`pwreset:ip:${meta.ip}`, 20, 3600);
  if (!lim.ok || !ipLim.ok) return; // silently drop — response is identical either way
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== 'ACTIVE') return;
  const token = randomToken(32);
  await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) } });
  const url = `${process.env.APP_URL}/reset-password?token=${token}`;
  await sendEmail({
    to: user.email,
    subject: `Reset your ${await productName()} password`,
    body: `Hi ${user.name},\n\nUse the link below to set a new password. It expires in 1 hour and can be used once.\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
  });
  await auditDetached({ requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent }, { action: 'auth.password.reset_requested', targetType: 'user', targetId: user.id });
}

export async function resetPassword(token: string, password: string, meta: RequestMeta) {
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!row || row.usedAt || row.expiresAt < new Date()) throw new AppError('PRECONDITION_FAILED', 'This reset link is invalid or has expired');
  const policy = await getSetting('security.policy');
  const problems = passwordProblems(password, policy.passwordMinLength, [row.user.email, row.user.name]);
  if (problems.length) throw new AppError('VALIDATION_FAILED', problems[0], problems);
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await hashPassword(password), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, mustChangePassword: false, tempPasswordExpiresAt: null } }),
    prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
  ]);
  await revokeAllSessions(row.userId, 'password_reset');
  await auditDetached({ requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent }, { action: 'auth.password.reset', targetType: 'user', targetId: row.userId });
}

export async function getInvitation(token: string) {
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(token) } });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) return null;
  const org = inv.organizationId ? await prisma.organization.findUnique({ where: { id: inv.organizationId }, select: { name: true, status: true } }) : null;
  if (org && org.status !== 'ACTIVE') return null;
  return { email: inv.email, name: inv.name, organizationName: org?.name ?? `${await productName()} Platform` };
}

export async function acceptInvitation(token: string, input: { name: string; password: string }, meta: RequestMeta) {
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(token) } });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw new AppError('PRECONDITION_FAILED', 'This invitation is invalid or has expired');
  const policy = await getSetting('security.policy');
  const problems = passwordProblems(input.password, policy.passwordMinLength, [inv.email, input.name]);
  if (problems.length) throw new AppError('VALIDATION_FAILED', problems[0], problems);
  const passwordHash = await hashPassword(input.password);
  const role = await prisma.role.findUniqueOrThrow({ where: { id: inv.roleId } });

  const user = await withPlatform(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email: inv.email }, include: { membership: true } });
    if (existing && existing.status !== 'INVITED') throw new AppError('CONFLICT', 'An account with this email already exists. Sign in instead.');
    const u = existing
      ? await tx.user.update({ where: { id: existing.id }, data: { name: input.name, passwordHash, status: 'ACTIVE', passwordChangedAt: new Date(), mustChangePassword: false, tempPasswordExpiresAt: null } })
      : await tx.user.create({ data: { email: inv.email, name: input.name, passwordHash, status: 'ACTIVE', isPlatformUser: role.scope === 'PLATFORM', passwordChangedAt: new Date() } });
    await tx.membership.upsert({
      where: { userId: u.id },
      create: { userId: u.id, organizationId: inv.organizationId, roleId: inv.roleId },
      update: { organizationId: inv.organizationId, roleId: inv.roleId },
    });
    await tx.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date(), userId: u.id } });
    await audit(tx, { requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent, user: { id: u.id, email: u.email, name: u.name, mfaEnabled: false } }, {
      action: 'auth.invitation.accepted', targetType: 'user', targetId: u.id, organizationId: inv.organizationId, metadata: { invitationId: inv.id, role: role.key },
    });
    return u;
  });
  return user;
}
