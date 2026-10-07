import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import type { PermissionKey, Scope } from '@/lib/permissions';
import { contextFromToken, type AuthContext } from './auth/context';
import { SESSION_COOKIE } from './auth/session';
import { auditDetached } from './audit';
import { AppError } from './errors';
import { onForbidden } from './security/alerts';

/** Resolves the current user for a server component, or null. Never throws for unauthenticated users. */
export async function currentContext(): Promise<AuthContext | null> {
  const jar = await cookies();
  const h = await headers();
  const token = jar.get(SESSION_COOKIE)?.value ?? null;
  if (!token) return null;
  const fwd = h.get('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  try {
    const res = await contextFromToken(token, {
      requestId: h.get('x-request-id') ?? randomUUID(),
      ip: (process.env.TRUST_PROXY === 'true' ? fwd[0] : fwd[fwd.length - 1]) ?? null,
      userAgent: h.get('user-agent'),
    });
    return res?.ctx ?? null;
  } catch (e) {
    if (e instanceof AppError && e.code === 'FORBIDDEN') redirect(`/login?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
}

export function homeFor(ctx: AuthContext) {
  return ctx.scope === 'PLATFORM' ? '/admin' : '/app';
}

/**
 * Server-side page guard. Frontend routing is never the access control — every API route enforces
 * the same checks — but pages must not render data the caller can't see.
 */
export async function requirePage(opts: { scope: Scope; perm?: PermissionKey | PermissionKey[] }): Promise<AuthContext> {
  const ctx = await currentContext();
  if (!ctx) redirect('/login');
  if (ctx.session?.mfaPending) redirect('/login/mfa');
  if (ctx.restriction === 'PASSWORD_CHANGE_REQUIRED') redirect('/account/change-password');
  if (ctx.restriction === 'MFA_ENROLLMENT_REQUIRED') redirect('/account/mfa-setup');
  if (ctx.scope !== opts.scope) redirect(homeFor(ctx));
  const perms = opts.perm ? (Array.isArray(opts.perm) ? opts.perm : [opts.perm]) : [];
  if (perms.length && !perms.some((p) => ctx.permissions.has(p))) {
    await auditDetached(ctx, { action: 'access.denied', result: 'DENIED', targetType: 'page', targetId: perms.join('|'), reason: 'missing permission' });
    await onForbidden(ctx.user.id, ctx.orgId, ctx.ip, `page:${perms.join('|')}`).catch(() => null);
    redirect(`/forbidden?from=${opts.scope === 'PLATFORM' ? 'admin' : 'app'}`);
  }
  return ctx;
}
