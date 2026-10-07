import type { Prisma } from '@prisma/client';
import { prisma, type Db } from '../db';

export type NotifyInput = { type: string; title: string; body?: string; link?: string; organizationId?: string | null; dedupeKey?: string };

export async function notifyUsers(userIds: string[], n: NotifyInput, db: Db = prisma) {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (!unique.length) return 0;
  const data: Prisma.NotificationCreateManyInput[] = unique.map((userId) => ({
    userId,
    type: n.type,
    title: n.title.slice(0, 200),
    body: n.body?.slice(0, 1000),
    link: n.link,
    organizationId: n.organizationId ?? null,
    dedupeKey: n.dedupeKey ? `${n.dedupeKey}:${userId}` : null,
  }));
  const res = await db.notification.createMany({ data, skipDuplicates: true });
  return res.count;
}

/** Users whose effective role grants `permission` — platform users when organizationId is null, otherwise members of that org. */
export async function usersWithPermission(permission: string, organizationId: string | null, db: Db = prisma) {
  const members = await db.membership.findMany({
    where: {
      organizationId,
      user: { status: 'ACTIVE' },
      OR: [
        { role: { permissions: { some: { permissionKey: permission } } }, NOT: { overrides: { some: { permissionKey: permission, effect: 'DENY' } } } },
        { overrides: { some: { permissionKey: permission, effect: 'GRANT' } } },
      ],
    },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}

export async function notifyPermission(permission: string, organizationId: string | null, n: NotifyInput, db: Db = prisma) {
  return notifyUsers(await usersWithPermission(permission, organizationId, db), { ...n, organizationId }, db);
}
