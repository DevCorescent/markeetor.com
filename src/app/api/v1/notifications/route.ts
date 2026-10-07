import { z } from 'zod';
import { route } from '@/server/api';
import { prisma } from '@/server/db';

export const GET = route(
  { scope: 'ANY', selfService: true, query: z.object({ pageSize: z.coerce.number().int().min(1).max(100).default(20), unreadOnly: z.enum(['1', '0']).optional() }) },
  async ({ ctx, query }) => {
    const where = { userId: ctx.user.id, ...(query.unreadOnly === '1' ? { readAt: null } : {}) };
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: query.pageSize }),
      prisma.notification.count({ where: { userId: ctx.user.id, readAt: null } }),
    ]);
    return { items, unread };
  },
);

export const PATCH = route(
  { scope: 'ANY', selfService: true, body: z.object({ ids: z.array(z.string().max(64)).max(200).optional(), all: z.boolean().optional() }) },
  async ({ ctx, body }) => {
    const res = await prisma.notification.updateMany({
      where: { userId: ctx.user.id, readAt: null, ...(body.all ? {} : { id: { in: body.ids ?? [] } }) },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  },
);
