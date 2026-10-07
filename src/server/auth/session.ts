import type { Session, User } from '@prisma/client';
import { prisma } from '../db';
import { randomToken, sha256 } from '../crypto';
import { getSetting } from '../settings';

export const SESSION_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-lc_session' : 'lc_session';

export function sessionCookieHeader(token: string, maxAgeSec: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function clearSessionCookieHeader(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export async function createSession(userId: string, meta: { ip?: string | null; userAgent?: string | null; mfaPending: boolean }) {
  const policy = await getSetting('security.policy');
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + policy.sessionAbsoluteHours * 3600_000);
  const session = await prisma.session.create({
    data: {
      tokenHash: sha256(token),
      userId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
      mfaPending: meta.mfaPending,
      mfaVerifiedAt: meta.mfaPending ? null : undefined,
      expiresAt,
    },
  });
  return { token, session, maxAgeSec: policy.sessionAbsoluteHours * 3600 };
}

export type ResolvedSession = Session & { user: User };

/** Validates a raw session token. Expired or idle sessions are revoked as a side effect. */
export async function resolveSession(token: string | null, idleMinutesOverride?: number): Promise<ResolvedSession | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const session = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!session || session.revokedAt) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await revokeSession(session.id, 'expired');
    return null;
  }
  const policy = await getSetting('security.policy');
  const idleMs = (idleMinutesOverride ?? policy.sessionIdleMinutes) * 60_000;
  if (now - session.lastSeenAt.getTime() > idleMs) {
    await revokeSession(session.id, 'idle_timeout');
    return null;
  }
  if (session.user.status !== 'ACTIVE') {
    await revokeSession(session.id, `user_${session.user.status.toLowerCase()}`);
    return null;
  }
  if (now - session.lastSeenAt.getTime() > 60_000) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => null);
  }
  return session;
}

export async function revokeSession(id: string, reason: string) {
  await prisma.session.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
}

export async function revokeAllSessions(userId: string, reason: string, exceptSessionId?: string) {
  const res = await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return res.count;
}
