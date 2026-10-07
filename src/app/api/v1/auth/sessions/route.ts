import { z } from 'zod';
import { route } from '@/server/api';
import { auditDetached } from '@/server/audit';
import { prisma } from '@/server/db';

export const GET = route({ scope: 'ANY', selfService: true }, async ({ ctx }) => {
  const sessions = await prisma.session.findMany({
    where: { userId: ctx.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true },
  });
  return { sessions: sessions.map((s) => ({ ...s, current: s.id === ctx.session?.id })) };
});

export const DELETE = route({ scope: 'ANY', selfService: true, body: z.object({ sessionId: z.string().max(64) }) }, async ({ ctx, body }) => {
  const res = await prisma.session.updateMany({
    where: { id: body.sessionId, userId: ctx.user.id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'revoked_by_user' },
  });
  if (res.count) await auditDetached(ctx, { action: 'auth.session.revoked', targetType: 'session', targetId: body.sessionId });
  return { revoked: res.count };
});
