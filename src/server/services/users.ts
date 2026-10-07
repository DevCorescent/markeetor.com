import type { Prisma, UserStatus } from '@prisma/client';
import { z } from 'zod';
import { ALL_PERMISSIONS, type PermissionKey } from '@/lib/permissions';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { revokeAllSessions } from '../auth/session';
import { randomToken, sha256 } from '../crypto';
import { prisma, withPlatform, type Db, type Tx } from '../db';
import { AppError, forbidden, notFound } from '../errors';
import { sendEmail } from '../mail';
import { onPrivilegeChange } from '../security/alerts';
import { requestPasswordReset } from './auth';
import { createApproval } from './approvals';
import { productName } from '../branding';

export const inviteInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(2).max(120),
  roleId: z.string().min(1).max(64),
  organizationId: z.string().max(64).nullable().optional(),
});

/** Resolves which roles the caller may grant. Prevents privilege escalation: you can never grant above your own rank. */
async function assertAssignableRole(db: Db, ctx: AuthContext, roleId: string, organizationId: string | null) {
  const role = await db.role.findUnique({ where: { id: roleId } });
  if (!role) throw notFound('Role');
  if (organizationId) {
    if (role.scope !== 'ORGANIZATION') throw new AppError('VALIDATION_FAILED', 'Only workspace roles can be assigned to workspace users');
    if (role.organizationId && role.organizationId !== organizationId) throw forbidden('That role belongs to another workspace');
  } else if (role.scope !== 'PLATFORM') {
    throw new AppError('VALIDATION_FAILED', 'Platform users require a platform role');
  }
  if (ctx.scope === 'ORGANIZATION') {
    if (organizationId !== ctx.orgId) throw forbidden();
    if (role.rank > ctx.role.rank) throw forbidden('You cannot grant a role more privileged than your own');
  } else if (role.scope === 'PLATFORM' && role.rank > ctx.role.rank) {
    throw forbidden('You cannot grant a role more privileged than your own');
  }
  return role;
}

export async function createInvitation(
  tx: Tx,
  ctx: AuthContext,
  input: { email: string; name: string; roleId: string; organizationId: string | null },
  opts: { skipApproval?: boolean } = {},
) {
  const email = input.email.toLowerCase();
  const role = await assertAssignableRole(tx, ctx, input.roleId, input.organizationId);
  const existing = await tx.user.findUnique({ where: { email } });
  if (existing && existing.status !== 'INVITED') throw new AppError('CONFLICT', 'A user with this email already exists');

  if (input.organizationId) {
    const quota = await tx.clientQuota.findUnique({ where: { organizationId: input.organizationId } });
    const [members, pending] = await Promise.all([
      tx.membership.count({ where: { organizationId: input.organizationId, user: { status: { in: ['ACTIVE', 'INVITED', 'SUSPENDED'] } } } }),
      tx.invitation.count({ where: { organizationId: input.organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    if (quota && members + pending >= quota.maxUsers) throw new AppError('CONFLICT', `This workspace has reached its user limit (${quota.maxUsers})`);
  }

  if (role.isPrivileged && !opts.skipApproval) {
    const approval = await createApproval(tx, ctx, {
      type: 'INVITE_PRIVILEGED',
      summary: `Invite ${email} as ${role.name}`,
      payload: { email, name: input.name, roleId: role.id, organizationId: input.organizationId },
    });
    return { pendingApproval: approval.id, inviteUrl: '' };
  }

  await tx.invitation.updateMany({ where: { email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  const token = randomToken(32);
  const inv = await tx.invitation.create({
    data: {
      email, name: input.name, organizationId: input.organizationId, roleId: role.id,
      tokenHash: sha256(token), invitedById: ctx.user.id, expiresAt: new Date(Date.now() + 7 * 86400_000),
    },
  });
  const inviteUrl = `${process.env.APP_URL}/invite/${token}`;
  const org = input.organizationId ? await tx.organization.findUnique({ where: { id: input.organizationId }, select: { name: true } }) : null;
  await sendEmail({
    to: email,
    subject: `You're invited to ${org?.name ?? (await productName())}`,
    body: `Hi ${input.name},\n\n${ctx.user.name} invited you to join ${org?.name ?? `the ${await productName()} platform`} as ${role.name}.\n\nSet your password here (link expires in 7 days):\n${inviteUrl}\n`,
  });
  await audit(tx, ctx, {
    action: 'user.invited', targetType: 'invitation', targetId: inv.id, organizationId: input.organizationId,
    after: { email, role: role.key },
  });
  return { invitationId: inv.id, inviteUrl, pendingApproval: null as string | null };
}

export async function inviteUser(ctx: AuthContext, input: z.infer<typeof inviteInput>) {
  const organizationId = ctx.scope === 'ORGANIZATION' ? ctx.orgId! : (input.organizationId ?? null);
  return withPlatform((tx) => createInvitation(tx, ctx, { ...input, organizationId }));
}

export async function revokeInvitation(ctx: AuthContext, invitationId: string) {
  return withPlatform(async (tx) => {
    const inv = await tx.invitation.findUnique({ where: { id: invitationId } });
    if (!inv || (ctx.scope === 'ORGANIZATION' && inv.organizationId !== ctx.orgId)) throw notFound('Invitation');
    if (inv.acceptedAt) throw new AppError('CONFLICT', 'Invitation already accepted');
    await tx.invitation.update({ where: { id: inv.id }, data: { revokedAt: new Date() } });
    await audit(tx, ctx, { action: 'user.invitation.revoked', targetType: 'invitation', targetId: inv.id, organizationId: inv.organizationId });
  });
}

/** Loads a user the caller is allowed to manage. Client admins only see their own workspace. */
async function managedUser(db: Db, ctx: AuthContext, userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, include: { membership: { include: { role: true } } } });
  if (!user || !user.membership) throw notFound('User');
  if (ctx.scope === 'ORGANIZATION' && user.membership.organizationId !== ctx.orgId) throw notFound('User');
  return user;
}

export async function listUsers(ctx: AuthContext, params: { q?: string; organizationId?: string | null; status?: UserStatus; platformOnly?: boolean; page: number; pageSize: number }) {
  const orgFilter: Prisma.MembershipWhereInput =
    ctx.scope === 'ORGANIZATION'
      ? { organizationId: ctx.orgId }
      : params.platformOnly
        ? { organizationId: null }
        : params.organizationId
          ? { organizationId: params.organizationId }
          : {};
  const where: Prisma.UserWhereInput = {
    membership: { is: orgFilter },
    ...(params.status ? { status: params.status } : {}),
    ...(params.q ? { OR: [{ name: { contains: params.q, mode: 'insensitive' } }, { email: { contains: params.q, mode: 'insensitive' } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: {
        id: true, email: true, name: true, status: true, mfaEnabled: true, lastLoginAt: true, lockedUntil: true, createdAt: true,
        membership: { select: { organizationId: true, organization: { select: { name: true, code: true } }, role: { select: { id: true, name: true, key: true } } } },
        _count: { select: { sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } } },
      },
    }),
  ]);
  return { total, rows };
}

export async function getUserDetail(ctx: AuthContext, userId: string) {
  const user = await managedUser(prisma, ctx, userId);
  const [sessions, logins, overrides, activity] = await Promise.all([
    prisma.session.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' }, take: 20 }),
    prisma.loginEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.permissionOverride.findMany({ where: { membershipId: user.membership!.id } }),
    withPlatform((tx) =>
      tx.auditEvent.findMany({
        where: { actorId: userId, ...(ctx.scope === 'ORGANIZATION' ? { organizationId: ctx.orgId } : {}) },
        orderBy: { seq: 'desc' }, take: 30,
        select: { id: true, action: true, targetType: true, targetId: true, result: true, createdAt: true, ip: true },
      }),
    ),
  ]);
  const org = user.membership!.organizationId
    ? await prisma.organization.findUnique({ where: { id: user.membership!.organizationId }, select: { id: true, name: true, code: true } })
    : null;
  return {
    user: {
      id: user.id, email: user.email, name: user.name, status: user.status, mfaEnabled: user.mfaEnabled, lockedUntil: user.lockedUntil,
      lastLoginAt: user.lastLoginAt, lastLoginIp: user.lastLoginIp, createdAt: user.createdAt, title: user.title,
    },
    role: user.membership!.role,
    organization: org,
    sessions: sessions.map((s) => ({ id: s.id, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt })),
    logins,
    overrides,
    activity,
  };
}

export async function changeUserRole(ctx: AuthContext, userId: string, roleId: string, reason: string) {
  return withPlatform(async (tx) => {
    const user = await managedUser(tx, ctx, userId);
    if (user.id === ctx.user.id) throw forbidden('You cannot change your own role');
    if (user.membership!.role.rank > ctx.role.rank) throw forbidden('You cannot modify a user more privileged than you');
    const role = await assertAssignableRole(tx, ctx, roleId, user.membership!.organizationId);
    if (role.id === user.membership!.roleId) return { changed: false, pendingApproval: null };
    if (role.isPrivileged) {
      const approval = await createApproval(tx, ctx, {
        type: 'ROLE_GRANT_PRIVILEGED',
        summary: `Grant ${role.name} to ${user.email}`,
        payload: { userId, roleId: role.id, reason },
      });
      return { changed: false, pendingApproval: approval.id };
    }
    await applyRoleChange(tx, ctx, user.id, role.id, reason);
    return { changed: true, pendingApproval: null };
  });
}

export async function applyRoleChange(tx: Tx, ctx: AuthContext, userId: string, roleId: string, reason: string) {
  const m = await tx.membership.findUniqueOrThrow({ where: { userId }, include: { role: true } });
  const role = await tx.role.findUniqueOrThrow({ where: { id: roleId } });
  await tx.membership.update({ where: { userId }, data: { roleId } });
  await audit(tx, ctx, {
    action: 'user.role.changed', targetType: 'user', targetId: userId, organizationId: m.organizationId, reason,
    before: { role: m.role.key }, after: { role: role.key },
  });
  await onPrivilegeChange({ actorId: ctx.user.id, targetUserId: userId, from: m.role.name, to: role.name, organizationId: m.organizationId });
}

export async function setUserStatus(ctx: AuthContext, userId: string, status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED', reason: string) {
  const res = await withPlatform(async (tx) => {
    const user = await managedUser(tx, ctx, userId);
    if (user.id === ctx.user.id) throw forbidden('You cannot change your own status');
    if (user.membership!.role.rank > ctx.role.rank) throw forbidden('You cannot modify a user more privileged than you');
    if (user.status === 'INVITED' && status === 'ACTIVE') throw new AppError('CONFLICT', 'The user has not accepted their invitation yet');
    await tx.user.update({ where: { id: userId }, data: { status, ...(status === 'ACTIVE' ? { failedLoginCount: 0, lockedUntil: null } : {}) } });
    await audit(tx, ctx, {
      action: `user.${status.toLowerCase()}`, targetType: 'user', targetId: userId, organizationId: user.membership!.organizationId, reason,
      before: { status: user.status }, after: { status },
    });
    return user;
  });
  if (status !== 'ACTIVE') await revokeAllSessions(userId, `user_${status.toLowerCase()}`);
  return { ok: true, email: res.email };
}

export async function adminUserAction(ctx: AuthContext, userId: string, action: 'unlock' | 'reset_mfa' | 'send_password_reset' | 'revoke_sessions', reason: string) {
  const user = await managedUser(prisma, ctx, userId);
  if (user.membership!.role.rank > ctx.role.rank) throw forbidden('You cannot modify a user more privileged than you');
  let detail: Record<string, unknown> = {};
  if (action === 'unlock') {
    await prisma.user.update({ where: { id: userId }, data: { lockedUntil: null, failedLoginCount: 0 } });
  } else if (action === 'reset_mfa') {
    await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: [] } });
    detail.sessionsRevoked = await revokeAllSessions(userId, 'mfa_reset');
  } else if (action === 'send_password_reset') {
    await requestPasswordReset(user.email, { requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent });
  } else if (action === 'revoke_sessions') {
    detail = { sessionsRevoked: await revokeAllSessions(userId, 'revoked_by_admin') };
  }
  await withPlatform((tx) =>
    audit(tx, ctx, { action: `user.${action}`, targetType: 'user', targetId: userId, organizationId: user.membership!.organizationId, reason, metadata: detail }),
  );
  return { ok: true, ...detail };
}

export const overrideInput = z.object({
  permissionKey: z.string().max(80),
  effect: z.enum(['GRANT', 'DENY']),
  reason: z.string().trim().min(3).max(500),
  expiresAt: z.coerce.date().nullable().optional(),
});

export async function setPermissionOverride(ctx: AuthContext, userId: string, input: z.infer<typeof overrideInput>) {
  return withPlatform(async (tx) => {
    const user = await managedUser(tx, ctx, userId);
    const def = Object.hasOwn(ALL_PERMISSIONS, input.permissionKey) ? ALL_PERMISSIONS[input.permissionKey as PermissionKey] : undefined;
    if (!def) throw new AppError('VALIDATION_FAILED', 'Unknown permission');
    const scope = user.membership!.role.scope;
    if (def.scope !== scope) throw new AppError('VALIDATION_FAILED', 'Permission scope does not match the user’s role scope');
    // You can only grant permissions you hold yourself.
    if (input.effect === 'GRANT' && !ctx.permissions.has(input.permissionKey)) throw forbidden('You can only grant permissions you hold');
    if (user.id === ctx.user.id) throw forbidden('You cannot override your own permissions');
    const row = await tx.permissionOverride.upsert({
      where: { membershipId_permissionKey: { membershipId: user.membership!.id, permissionKey: input.permissionKey } },
      create: { membershipId: user.membership!.id, permissionKey: input.permissionKey, effect: input.effect, reason: input.reason, grantedById: ctx.user.id, expiresAt: input.expiresAt ?? null },
      update: { effect: input.effect, reason: input.reason, grantedById: ctx.user.id, expiresAt: input.expiresAt ?? null },
    });
    await audit(tx, ctx, {
      action: 'user.permission_override.set', targetType: 'user', targetId: userId, organizationId: user.membership!.organizationId,
      reason: input.reason, after: { permission: input.permissionKey, effect: input.effect, expiresAt: input.expiresAt ?? null },
    });
    if (input.effect === 'GRANT' && def.sensitive) {
      await onPrivilegeChange({ actorId: ctx.user.id, targetUserId: userId, to: `override +${input.permissionKey}`, organizationId: user.membership!.organizationId });
    }
    return row;
  });
}

export async function removePermissionOverride(ctx: AuthContext, userId: string, permissionKey: string) {
  return withPlatform(async (tx) => {
    const user = await managedUser(tx, ctx, userId);
    const res = await tx.permissionOverride.deleteMany({ where: { membershipId: user.membership!.id, permissionKey } });
    if (res.count) {
      await audit(tx, ctx, { action: 'user.permission_override.removed', targetType: 'user', targetId: userId, organizationId: user.membership!.organizationId, before: { permission: permissionKey } });
    }
    return { removed: res.count };
  });
}

export async function listInvitations(ctx: AuthContext, organizationId: string | null | undefined) {
  const where: Prisma.InvitationWhereInput = {
    acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() },
    ...(ctx.scope === 'ORGANIZATION' ? { organizationId: ctx.orgId } : organizationId !== undefined ? { organizationId } : {}),
  };
  const rows = await prisma.invitation.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
  const roles = await prisma.role.findMany({ where: { id: { in: rows.map((r) => r.roleId) } }, select: { id: true, name: true } });
  const roleMap = new Map(roles.map((r) => [r.id, r.name]));
  return rows.map((r) => ({ id: r.id, email: r.email, name: r.name, organizationId: r.organizationId, role: roleMap.get(r.roleId) ?? '—', expiresAt: r.expiresAt, createdAt: r.createdAt }));
}
