import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { withPlatform } from '../db';
import { AppError } from '../errors';
import { enqueue } from '../jobs/queues';
import { logger } from '../logger';
import { getPricing } from './marketplace';
import { usersWithPermission } from './notifications';

/**
 * Announcements are broadcast notifications from the platform to client dashboards. They land in each
 * recipient's notification bell and appear as a banner on the client dashboard. "New leads" announcements
 * are sent automatically after imports or manual additions, summarising what became available.
 */

export const broadcastInput = z.object({
  title: z.string().trim().min(3).max(140),
  body: z.string().trim().max(600).optional(),
  link: z.string().trim().max(300).regex(/^\/(app|account)(\/|$|\?)/, 'Links must point inside the client app (e.g. /app/marketplace)').optional().or(z.literal('')),
  scope: z.enum(['ALL', 'ORGS']),
  organizationIds: z.array(z.string().max(64)).max(500).default([]),
  /** Only users allowed to browse the marketplace (otherwise every active member). */
  marketplaceOnly: z.boolean().default(false),
});
export type BroadcastInput = z.infer<typeof broadcastInput>;

type Audience = { scope: 'ALL' | 'ORGS'; organizationIds?: string[]; marketplaceOnly?: boolean };

async function recipients(aud: Audience) {
  return withPlatform(async (tx) => {
    const orgs = await tx.organization.findMany({
      where: { status: 'ACTIVE', ...(aud.scope === 'ORGS' ? { id: { in: aud.organizationIds ?? [] } } : {}) },
      select: { id: true, settings: true },
    });
    const eligible = aud.marketplaceOnly ? orgs.filter((o) => (o.settings as { features?: { marketplace?: boolean } } | null)?.features?.marketplace !== false) : orgs;
    const out: { userId: string; organizationId: string }[] = [];
    for (const o of eligible) {
      const ids = aud.marketplaceOnly
        ? await usersWithPermission('crm.marketplace.view', o.id, tx)
        : (await tx.membership.findMany({ where: { organizationId: o.id, user: { status: 'ACTIVE' } }, select: { userId: true } })).map((m) => m.userId);
      for (const userId of new Set(ids)) out.push({ userId, organizationId: o.id });
    }
    return { recipients: out, orgCount: eligible.length };
  });
}

async function send(kind: 'MANUAL' | 'NEW_LEADS', n: { title: string; body?: string | null; link?: string | null }, aud: Audience, actorId: string | null) {
  const { recipients: list, orgCount } = await recipients(aud);
  return withPlatform(async (tx) => {
    const a = await tx.announcement.create({
      data: { kind, title: n.title, body: n.body || null, link: n.link || null, audience: aud as Prisma.InputJsonValue, recipientCount: list.length, orgCount, createdById: actorId },
    });
    for (let i = 0; i < list.length; i += 2000) {
      await tx.notification.createMany({
        data: list.slice(i, i + 2000).map((r) => ({
          userId: r.userId, organizationId: r.organizationId, type: kind === 'NEW_LEADS' ? 'NEW_LEADS' : 'ANNOUNCEMENT',
          title: n.title.slice(0, 200), body: n.body?.slice(0, 1000) ?? null, link: n.link || null, dedupeKey: `ann:${a.id}:${r.userId}`,
        })),
        skipDuplicates: true,
      });
    }
    return a;
  }, { timeout: 60_000 });
}

export async function broadcast(ctx: AuthContext, input: BroadcastInput) {
  if (input.scope === 'ORGS' && !input.organizationIds.length) throw new AppError('VALIDATION_FAILED', 'Choose at least one workspace');
  const a = await send('MANUAL', { title: input.title, body: input.body, link: input.link || null }, { scope: input.scope, organizationIds: input.organizationIds, marketplaceOnly: input.marketplaceOnly }, ctx.user.id);
  await withPlatform((tx) => audit(tx, ctx, { action: 'announcement.sent', targetType: 'announcement', targetId: a.id, organizationId: null, metadata: { title: a.title, recipients: a.recipientCount, workspaces: a.orgCount, scope: input.scope } }));
  return a;
}

/**
 * Announces leads that became available in the marketplace since the last "new leads" announcement.
 * Idempotent and safe to run often: nothing is sent when nothing new is available.
 */
export async function announceNewLeads(opts: { force?: boolean } = {}) {
  const p = await getPricing();
  if (!p.marketplaceEnabled || (!p.autoAnnounce && !opts.force)) return null;
  const summary = await withPlatform(async (tx) => {
    const last = await tx.announcement.findFirst({ where: { kind: 'NEW_LEADS' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const since = last?.createdAt ?? new Date(Date.now() - 24 * 3600_000);
    const where: Prisma.LeadWhereInput = { createdAt: { gt: since }, allocationStatus: 'UNALLOCATED', archivedAt: null, mergedIntoId: null, quality: 'VALID' };
    const count = await tx.lead.count({ where });
    if (!count) return null;
    const top = async (field: 'industry' | 'country') =>
      (await tx.lead.groupBy({ by: [field], where: { ...where, [field]: { not: null } }, _count: true, orderBy: { _count: { [field]: 'desc' } }, take: 3 })).map((r) => r[field] as string);
    const [industries, countries] = await Promise.all([top('industry'), top('country')]);
    return { count, industries, countries };
  });
  if (!summary) return null;
  const detail = [summary.industries.length && `Industries: ${summary.industries.join(', ')}`, summary.countries.length && `Countries: ${summary.countries.join(', ')}`].filter(Boolean).join(' · ');
  const a = await send('NEW_LEADS', {
    title: `${summary.count.toLocaleString()} new lead${summary.count === 1 ? ' is' : 's are'} available`,
    body: `${detail ? `${detail}. ` : ''}Browse the marketplace and request the ones you want${p.freeLeadsPerClient ? ' — your free demo leads apply automatically' : ''}.`,
    link: '/app/marketplace?sort=new',
  }, { scope: 'ALL', marketplaceOnly: true }, null);
  logger.info({ announcement: a.id, leads: summary.count, recipients: a.recipientCount }, 'new-leads announcement sent');
  return a;
}

/** Schedules an announcement shortly after leads are added; bursts within the window collapse into one. */
export async function scheduleNewLeadsAnnouncement(delayMs = 2 * 60_000) {
  const bucket = Math.floor(Date.now() / delayMs);
  await enqueue('maintenance', 'announce-new-leads', {}, { jobId: `announce-${bucket}`, delay: delayMs }).catch((err) => logger.warn({ err }, 'could not schedule announcement'));
}

export async function listAnnouncements(params: { page: number; pageSize: number; kind?: string }) {
  return withPlatform(async (tx) => {
    const where = params.kind ? { kind: params.kind } : {};
    const [total, rows] = await Promise.all([
      tx.announcement.count({ where }),
      tx.announcement.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
    ]);
    const users = await tx.user.findMany({ where: { id: { in: rows.map((r) => r.createdById).filter(Boolean) as string[] } }, select: { id: true, name: true } });
    const readCounts = await Promise.all(rows.map((r) => tx.notification.count({ where: { dedupeKey: { startsWith: `ann:${r.id}:` }, readAt: { not: null } } })));
    return { total, rows: rows.map((r, i) => ({ ...r, author: users.find((u) => u.id === r.createdById)?.name ?? (r.kind === 'NEW_LEADS' ? 'Automatic' : '—'), readCount: readCounts[i] })) };
  });
}

/** Recent announcements addressed to a workspace (for the client dashboard banner). */
export async function announcementsFor(organizationId: string, days = 14) {
  const rows = await withPlatform((tx) => tx.announcement.findMany({ where: { createdAt: { gte: new Date(Date.now() - days * 86400_000) } }, orderBy: { createdAt: 'desc' }, take: 30 }));
  return rows
    .filter((r) => {
      const a = r.audience as Audience;
      return a.scope === 'ALL' || (a.organizationIds ?? []).includes(organizationId);
    })
    .slice(0, 5)
    .map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, createdAt: r.createdAt }));
}
