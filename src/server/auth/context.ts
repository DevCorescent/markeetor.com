import type { Organization } from '@prisma/client';
import type { PermissionKey, Scope } from '@/lib/permissions';
import { prisma, withPlatform, withTenant, type Tx } from '../db';
import { AppError } from '../errors';
import { getSetting } from '../settings';
import { resolveSession, type ResolvedSession } from './session';

export type RequestMeta = { requestId: string; ip: string | null; userAgent: string | null };

export type AuthContext = RequestMeta & {
  user: { id: string; email: string; name: string; mfaEnabled: boolean };
  session: { id: string; mfaPending: boolean; mfaVerifiedAt: Date | null; stepUpAt: Date | null; createdAt: Date } | null;
  apiKeyId?: string;
  scope: Scope;
  orgId: string | null;
  org: Pick<Organization, 'id' | 'name' | 'code' | 'status' | 'settings' | 'logoKey'> | null;
  role: { id: string; key: string; name: string; rank: number };
  permissions: Set<string>;
  /** Set when the session cannot proceed (e.g. MFA enrollment required by policy). */
  restriction: null | 'MFA_ENROLLMENT_REQUIRED' | 'PASSWORD_CHANGE_REQUIRED';
};

/** Loads the effective authorization context for a user: role permissions ± active overrides. */
export async function buildContext(userId: string, meta: RequestMeta, session: ResolvedSession | null): Promise<AuthContext> {
  const membership = await prisma.membership.findUnique({
    where: { userId },
    include: {
      user: true,
      role: { include: { permissions: true } },
      organization: { select: { id: true, name: true, code: true, status: true, settings: true, logoKey: true } },
      overrides: true,
    },
  });
  if (!membership) throw new AppError('FORBIDDEN', 'Your account has no workspace access');
  const scope = membership.role.scope as Scope;
  if (scope === 'ORGANIZATION') {
    if (!membership.organization) throw new AppError('FORBIDDEN', 'Workspace not found');
    if (membership.organization.status !== 'ACTIVE') {
      throw new AppError('FORBIDDEN', `This workspace is ${membership.organization.status.toLowerCase()}. Contact your administrator.`);
    }
  }
  const perms = new Set<string>(membership.role.permissions.map((p) => p.permissionKey));
  const now = Date.now();
  for (const o of membership.overrides) {
    if (o.expiresAt && o.expiresAt.getTime() < now) continue;
    if (o.effect === 'GRANT') perms.add(o.permissionKey);
    else perms.delete(o.permissionKey);
  }
  // Defence in depth: drop anything that doesn't match the role's scope.
  for (const p of [...perms]) {
    const platform = !p.startsWith('crm.');
    if ((scope === 'PLATFORM') !== platform) perms.delete(p);
  }

  let restriction: AuthContext['restriction'] = null;
  // An emailed temporary password must be replaced before anything else (including MFA enrollment).
  if (session && membership.user.mustChangePassword) restriction = 'PASSWORD_CHANGE_REQUIRED';
  else if (session && !membership.user.mfaEnabled) {
    const orgSecurity = (membership.organization?.settings as { security?: { mfaRequired?: boolean } } | null)?.security;
    const policy = await getSetting('security.policy');
    const required = scope === 'PLATFORM' ? policy.mfaRequiredForPlatform : Boolean(orgSecurity?.mfaRequired);
    if (required) restriction = 'MFA_ENROLLMENT_REQUIRED';
  }

  return {
    ...meta,
    user: { id: membership.user.id, email: membership.user.email, name: membership.user.name, mfaEnabled: membership.user.mfaEnabled },
    session: session
      ? { id: session.id, mfaPending: session.mfaPending, mfaVerifiedAt: session.mfaVerifiedAt, stepUpAt: session.stepUpAt, createdAt: session.createdAt }
      : null,
    scope,
    orgId: membership.organizationId,
    org: membership.organization,
    role: { id: membership.role.id, key: membership.role.key, name: membership.role.name, rank: membership.role.rank },
    permissions: perms,
    restriction,
  };
}

export async function contextFromToken(token: string | null, meta: RequestMeta) {
  const session = await resolveSession(token);
  if (!session) return null;
  // Per-organization idle timeout (stricter than platform default) is enforced here.
  const ctx = await buildContext(session.userId, meta, session);
  const orgIdle = (ctx.org?.settings as { security?: { sessionIdleMinutes?: number } } | null)?.security?.sessionIdleMinutes;
  if (orgIdle && Date.now() - session.lastSeenAt.getTime() > orgIdle * 60_000) {
    await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokedReason: 'idle_timeout' } });
    return null;
  }
  return { ctx, session };
}

export function can(ctx: Pick<AuthContext, 'permissions'>, ...anyOf: PermissionKey[]): boolean {
  return anyOf.some((p) => ctx.permissions.has(p));
}

export function assertCan(ctx: AuthContext, ...anyOf: PermissionKey[]) {
  if (!can(ctx, ...anyOf)) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action', { required: anyOf });
}

/** Returns the caller's organization id, or throws if the caller is not tenant-scoped. Never trust a client-supplied tenant id. */
export function tenantOf(ctx: AuthContext): string {
  if (ctx.scope !== 'ORGANIZATION' || !ctx.orgId) throw new AppError('FORBIDDEN', 'This action is only available inside a client workspace');
  return ctx.orgId;
}

/** Runs a DB transaction with visibility that matches the caller's scope. */
export function scopedDb<T>(ctx: AuthContext, fn: (tx: Tx) => Promise<T>, opts?: { timeout?: number }): Promise<T> {
  if (ctx.scope === 'PLATFORM') return withPlatform(fn, opts);
  return withTenant(tenantOf(ctx), fn, opts);
}

export async function requireStepUp(ctx: AuthContext) {
  const policy = await getSetting('security.policy');
  const at = ctx.session?.stepUpAt?.getTime() ?? 0;
  if (Date.now() - at > policy.stepUpMinutes * 60_000) {
    throw new AppError('STEP_UP_REQUIRED', 'Please confirm your identity to continue');
  }
}
