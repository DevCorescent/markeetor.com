import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { filterSchema, type Filter } from '@/lib/filters';
import { growthSettingsSchema, DEFAULT_GROWTH, type GrowthSettings } from '@/lib/growth';
import { audit } from '../audit';
import { buildContext, can, type AuthContext } from '../auth/context';
import { withPlatform } from '../db';
import { AppError, notFound } from '../errors';
import { logger } from '../logger';
import { sendEmail } from '../mail';
import { getSetting, invalidateSetting } from '../settings';
import { notifyUsers } from './notifications';
import { createLeadRequest, getPricing, listCatalog, marketWhere, PRICE_SELECT, priceRow, safeFilter } from './marketplace';

/**
 * Saved marketplace searches. A background check (every 15 minutes) finds leads that arrived since the
 * last check, alerts the owner in-app and/or by email, and — when auto-buy is on — requests them paid with
 * credits, within the search's weekly cap and price ceiling (and the workspace's spending limits).
 * Plus the per-user watchlist (shortlisted marketplace leads).
 */

export async function getGrowth(): Promise<GrowthSettings> {
  const raw = await getSetting('growth');
  const parsed = growthSettingsSchema.safeParse({ ...DEFAULT_GROWTH, ...(raw as object) });
  return parsed.success ? parsed.data : DEFAULT_GROWTH;
}

export async function saveGrowth(ctx: AuthContext, input: GrowthSettings) {
  const value = growthSettingsSchema.parse(input);
  const before = await getGrowth();
  await withPlatform(async (tx) => {
    await tx.platformSetting.upsert({ where: { key: 'growth' }, create: { key: 'growth', value: value as unknown as Prisma.InputJsonValue, updatedById: ctx.user.id }, update: { value: value as unknown as Prisma.InputJsonValue, updatedById: ctx.user.id } });
    await audit(tx, ctx, { action: 'settings.growth.updated', targetType: 'platform_setting', targetId: 'growth', organizationId: null, before, after: value });
  });
  invalidateSetting('growth');
  return value;
}

export const savedSearchInput = z.object({
  name: z.string().trim().min(1).max(80),
  filter: filterSchema,
  alertInApp: z.boolean().default(true),
  alertEmail: z.boolean().default(false),
  autoBuy: z.boolean().default(false),
  autoBuyMaxPerWeek: z.number().int().min(1).max(5000).default(10),
  autoBuyMaxPrice: z.number().min(0).max(1_000_000).nullable().default(null),
  active: z.boolean().default(true),
});
type Input = z.infer<typeof savedSearchInput>;

const serialize = (s: Prisma.SavedSearchGetPayload<object>) => ({ ...s, autoBuyMaxPrice: s.autoBuyMaxPrice == null ? null : Number(s.autoBuyMaxPrice) });

function clean(input: Input, g: GrowthSettings, ctx: AuthContext): Input {
  if (input.autoBuy && !g.savedSearches.autoBuyEnabled) throw new AppError('FORBIDDEN', 'Auto-buy is not available right now');
  if (input.autoBuy && !can(ctx, 'crm.marketplace.request')) throw new AppError('FORBIDDEN', 'You need permission to request leads to turn on auto-buy');
  return { ...input, filter: { conditions: safeFilter(input.filter as Filter).conditions }, autoBuyMaxPerWeek: Math.min(input.autoBuyMaxPerWeek, g.savedSearches.maxAutoBuyPerWeek) };
}

export async function listSavedSearches(ctx: AuthContext) {
  const rows = await withPlatform((tx) => tx.savedSearch.findMany({ where: { organizationId: ctx.orgId! }, orderBy: { createdAt: 'desc' } }));
  // Live count of what matches right now (and what is new since the last check).
  const out = await withPlatform(async (tx) => Promise.all(rows.map(async (s) => {
    const where = marketWhere(s.filter as Filter);
    const [total, fresh] = await Promise.all([tx.lead.count({ where }), tx.lead.count({ where: { AND: [where, { createdAt: { gt: s.cursorAt } }] } })]);
    return { ...serialize(s), matches: total, newMatches: fresh };
  })));
  const g = await getGrowth();
  return { rows: out, limits: { max: g.savedSearches.maxPerWorkspace, autoBuyEnabled: g.savedSearches.autoBuyEnabled, maxAutoBuyPerWeek: g.savedSearches.maxAutoBuyPerWeek } };
}

export async function createSavedSearch(ctx: AuthContext, input: Input) {
  const g = await getGrowth();
  if (!g.savedSearches.enabled) throw new AppError('FORBIDDEN', 'Saved searches are not available right now');
  const v = clean(input, g, ctx);
  return withPlatform(async (tx) => {
    const n = await tx.savedSearch.count({ where: { organizationId: ctx.orgId! } });
    if (n >= g.savedSearches.maxPerWorkspace) throw new AppError('CONFLICT', `Your workspace can keep up to ${g.savedSearches.maxPerWorkspace} saved searches`);
    const s = await tx.savedSearch.create({ data: { ...v, filter: v.filter as Prisma.InputJsonValue, organizationId: ctx.orgId!, createdById: ctx.user.id } });
    await audit(tx, ctx, { action: 'marketplace.search.saved', targetType: 'saved_search', targetId: s.id, metadata: { name: s.name, autoBuy: s.autoBuy } });
    return serialize(s);
  });
}

export async function updateSavedSearch(ctx: AuthContext, id: string, input: Input) {
  const g = await getGrowth();
  const v = clean(input, g, ctx);
  return withPlatform(async (tx) => {
    const s = await tx.savedSearch.findUnique({ where: { id } });
    if (!s || s.organizationId !== ctx.orgId) throw notFound('Saved search');
    const u = await tx.savedSearch.update({ where: { id }, data: { ...v, filter: v.filter as Prisma.InputJsonValue } });
    await audit(tx, ctx, { action: 'marketplace.search.updated', targetType: 'saved_search', targetId: id, before: { autoBuy: s.autoBuy, active: s.active }, after: { autoBuy: u.autoBuy, active: u.active } });
    return serialize(u);
  });
}

export async function deleteSavedSearch(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const s = await tx.savedSearch.findUnique({ where: { id } });
    if (!s || s.organizationId !== ctx.orgId) throw notFound('Saved search');
    await tx.savedSearch.delete({ where: { id } });
    await audit(tx, ctx, { action: 'marketplace.search.deleted', targetType: 'saved_search', targetId: id });
    return { ok: true };
  });
}

/** "Seen": the new-match badge resets (the next alert only covers later arrivals). */
export async function markSearchSeen(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const s = await tx.savedSearch.findUnique({ where: { id } });
    if (!s || s.organizationId !== ctx.orgId) throw notFound('Saved search');
    return serialize(await tx.savedSearch.update({ where: { id }, data: { cursorAt: new Date(), lastMatchCount: 0 } }));
  });
}

// ── Background check ───────────────────────────────────────────────

const AUTO_TAG = (id: string) => `[auto:${id}]`;

async function boughtThisWeek(searchId: string, orgId: string) {
  const r = await withPlatform((tx) => tx.leadRequest.aggregate({
    where: { organizationId: orgId, note: { contains: AUTO_TAG(searchId) }, createdAt: { gte: new Date(Date.now() - 7 * 86400_000) }, status: { in: ['PENDING', 'FULFILLED', 'PARTIAL'] } },
    _sum: { leadCount: true },
  }));
  return r._sum.leadCount ?? 0;
}

/** One search: alert on new matches, then auto-buy within limits. Returns what happened (for tests and logs). */
export async function runSavedSearch(id: string) {
  const s = await withPlatform((tx) => tx.savedSearch.findUnique({ where: { id } }));
  if (!s || !s.active) return { skipped: true as const };
  const g = await getGrowth();
  const where = { AND: [marketWhere(s.filter as Filter), { createdAt: { gt: s.cursorAt } }] };
  const fresh = await withPlatform((tx) => tx.lead.findMany({ where, select: { ...PRICE_SELECT }, orderBy: [{ score: 'desc' }, { createdAt: 'asc' }], take: 500 }));
  const newest = fresh.reduce((m, l) => (l.createdAt > m ? l.createdAt : m), s.cursorAt);
  let bought = 0;
  let note: string | null = null;

  if (fresh.length && s.autoBuy && g.savedSearches.autoBuyEnabled) {
    try {
      const ctx = await buildContext(s.createdById, { requestId: randomUUID(), ip: null, userAgent: 'auto-buy' }, null);
      if (ctx.orgId !== s.organizationId || !can(ctx, 'crm.marketplace.request')) throw new AppError('FORBIDDEN', 'The search owner can no longer request leads');
      const room = Math.max(0, Math.min(s.autoBuyMaxPerWeek, g.savedSearches.maxAutoBuyPerWeek) - (await boughtThisWeek(s.id, s.organizationId)));
      const p = await getPricing();
      const max = s.autoBuyMaxPrice == null ? null : Math.round(Number(s.autoBuyMaxPrice) * 100);
      const ids = fresh.filter((l) => max == null || priceRow(l, p).cents <= max).slice(0, Math.min(room, p.maxPerRequest)).map((l) => l.id);
      if (!room) note = 'weekly auto-buy limit reached';
      else if (!ids.length) note = 'no new matches under your price limit';
      else {
        const r = await createLeadRequest(ctx, { selection: { mode: 'ids', ids }, acceptCharges: true, paymentMethod: 'CREDITS', note: `Auto-buy · ${s.name} ${AUTO_TAG(s.id)}` });
        bought = r.leadCount;
        await withPlatform((tx) => tx.savedSearch.update({ where: { id: s.id }, data: { lastAutoBuyAt: new Date(), totalAutoBought: { increment: bought } } }));
      }
    } catch (err) {
      note = err instanceof AppError ? err.message : 'auto-buy failed';
      logger.warn({ err, search: s.id }, 'auto-buy skipped');
    }
  }

  const alert = fresh.length > 0 && (s.alertInApp || s.alertEmail);
  if (alert) {
    const title = bought ? `Auto-bought ${bought} lead${bought === 1 ? '' : 's'} for “${s.name}”` : `${fresh.length} new lead${fresh.length === 1 ? '' : 's'} match “${s.name}”`;
    const body = [bought && fresh.length > bought ? `${fresh.length - bought} more new matches` : null, note && s.autoBuy ? `Auto-buy: ${note}` : null].filter(Boolean).join(' · ') || 'Open the marketplace to review them.';
    const link = bought ? '/app/marketplace?tab=requests' : `/app/marketplace?tab=saved&search=${s.id}`;
    if (s.alertInApp) await notifyUsers([s.createdById], { type: 'SAVED_SEARCH', organizationId: s.organizationId, title, body, link });
    if (s.alertEmail) {
      const u = await withPlatform((tx) => tx.user.findUnique({ where: { id: s.createdById }, select: { email: true, status: true } }));
      if (u?.status === 'ACTIVE') await sendEmail({ to: u.email, subject: title, body: `${title}.\n\n${body}\n\n${process.env.APP_URL ?? ''}${link}` }).catch(() => null);
    }
  }
  await withPlatform((tx) => tx.savedSearch.update({
    where: { id: s.id },
    data: { lastCheckedAt: new Date(), cursorAt: newest, lastMatchCount: fresh.length, ...(alert ? { lastAlertAt: new Date() } : {}) },
  }));
  return { skipped: false as const, newMatches: fresh.length, bought, note };
}

/** Worker: every active search. */
export async function runSavedSearches() {
  const g = await getGrowth();
  if (!g.savedSearches.enabled) return { checked: 0 };
  const ids = await withPlatform((tx) => tx.savedSearch.findMany({ where: { active: true }, select: { id: true } }));
  let checked = 0;
  for (const { id } of ids) {
    await runSavedSearch(id).catch((err) => logger.warn({ err, search: id }, 'saved search check failed'));
    checked++;
  }
  return { checked };
}

// ── Watchlist ──────────────────────────────────────────────────────

export async function watchedIds(ctx: AuthContext) {
  const rows = await withPlatform((tx) => tx.marketWatch.findMany({ where: { userId: ctx.user.id }, select: { leadId: true } }));
  return rows.map((r) => r.leadId);
}

export async function toggleWatch(ctx: AuthContext, leadId: string, on: boolean) {
  return withPlatform(async (tx) => {
    if (!on) {
      await tx.marketWatch.deleteMany({ where: { userId: ctx.user.id, leadId } });
      return { watched: false };
    }
    const n = await tx.marketWatch.count({ where: { userId: ctx.user.id } });
    if (n >= 200) throw new AppError('CONFLICT', 'Your watchlist is full (200 leads). Remove some first.');
    await tx.marketWatch.upsert({ where: { userId_leadId: { userId: ctx.user.id, leadId } }, create: { organizationId: ctx.orgId!, userId: ctx.user.id, leadId }, update: {} });
    return { watched: true };
  });
}

/** The watchlist as marketplace rows (leads sold to someone else meanwhile drop out). */
export async function watchlist(ctx: AuthContext) {
  const ids = await watchedIds(ctx);
  if (!ids.length) return { total: 0, rows: [], gone: 0, currency: (await getPricing()).currency };
  const res = await listCatalog(ctx, { filter: { conditions: [] }, page: 1, pageSize: 200, ids });
  const gone = ids.filter((id) => !res.rows.some((r) => r.id === id));
  if (gone.length) await withPlatform((tx) => tx.marketWatch.deleteMany({ where: { userId: ctx.user.id, leadId: { in: gone } } }));
  return { ...res, gone: gone.length };
}
