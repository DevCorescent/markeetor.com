import type { Coupon } from '@prisma/client';
import { z } from 'zod';
import type { QuoteCoupon } from '@/lib/pricing';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { withPlatform, type Tx } from '../db';
import { AppError, notFound } from '../errors';

/**
 * Marketplace coupons. Created by the platform; visible coupons are offered on client dashboards and in the
 * request dialog. A redemption is recorded with the request (so limits hold under concurrency) and released
 * again if the request is cancelled, rejected or delivers nothing.
 */

export const couponInput = z.object({
  code: z.string().trim().toUpperCase().min(3).max(32).regex(/^[A-Z0-9_-]+$/, 'Use letters, numbers, - and _ only'),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  type: z.enum(['PERCENT', 'FIXED', 'FREE_LEADS']),
  value: z.number().positive().max(100_000),
  maxDiscount: z.number().positive().max(1_000_000).nullable().optional(),
  minLeads: z.number().int().min(0).max(100_000).default(0),
  minSubtotal: z.number().min(0).max(1_000_000).default(0),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
  perClientLimit: z.number().int().min(1).max(1000).default(1),
  organizationIds: z.array(z.string().max(64)).max(500).default([]),
  visibleToClients: z.boolean().default(true),
  firstRequestOnly: z.boolean().default(false),
  active: z.boolean().default(true),
}).refine((c) => c.type !== 'PERCENT' || c.value <= 100, { message: 'A percentage can be at most 100', path: ['value'] })
  .refine((c) => c.type !== 'FREE_LEADS' || Number.isInteger(c.value), { message: 'Free leads must be a whole number', path: ['value'] })
  .refine((c) => !c.startsAt || !c.endsAt || c.endsAt > c.startsAt, { message: 'The end date must be after the start date', path: ['endsAt'] });
export type CouponInput = z.infer<typeof couponInput>;

const ACTIVE_REQUEST = { in: ['PENDING', 'FULFILLED', 'PARTIAL'] as ('PENDING' | 'FULFILLED' | 'PARTIAL')[] };

const view = (c: Coupon & { _count?: { redemptions: number } }) => ({
  ...c, value: Number(c.value), maxDiscount: c.maxDiscount == null ? null : Number(c.maxDiscount), minSubtotal: Number(c.minSubtotal), redemptionCount: c._count?.redemptions ?? 0,
});

export const toQuoteCoupon = (c: Pick<Coupon, 'code' | 'type' | 'value' | 'maxDiscount'>): QuoteCoupon => ({ code: c.code, type: c.type, value: Number(c.value), maxDiscount: c.maxDiscount == null ? null : Number(c.maxDiscount) });

// ── Admin ──────────────────────────────────────────────────────────

export async function listCoupons() {
  return withPlatform(async (tx) => {
    const rows = await tx.coupon.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { redemptions: true } } } });
    const totals = await tx.couponRedemption.groupBy({ by: ['couponId'], _sum: { discount: true, extraFreeLeads: true } });
    return rows.map((r) => {
      const t = totals.find((x) => x.couponId === r.id);
      return { ...view(r), discountGiven: Number(t?._sum.discount ?? 0), freeLeadsGiven: t?._sum.extraFreeLeads ?? 0 };
    });
  });
}

export async function saveCoupon(ctx: AuthContext, id: string | null, input: CouponInput) {
  const data = { ...input, description: input.description ?? null, maxDiscount: input.maxDiscount ?? null, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, maxRedemptions: input.maxRedemptions ?? null };
  return withPlatform(async (tx) => {
    const clash = await tx.coupon.findUnique({ where: { code: data.code } });
    if (clash && clash.id !== id) throw new AppError('CONFLICT', `The code ${data.code} is already in use`);
    if (id) {
      const before = await tx.coupon.findUnique({ where: { id } });
      if (!before) throw notFound('Coupon');
      const c = await tx.coupon.update({ where: { id }, data });
      await audit(tx, ctx, { action: 'coupon.updated', targetType: 'coupon', targetId: id, organizationId: null, before: view(before), after: view(c) });
      return view(c);
    }
    const c = await tx.coupon.create({ data: { ...data, createdById: ctx.user.id } });
    await audit(tx, ctx, { action: 'coupon.created', targetType: 'coupon', targetId: c.id, organizationId: null, after: view(c) });
    return view(c);
  });
}

export async function deleteCoupon(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const c = await tx.coupon.findUnique({ where: { id }, include: { _count: { select: { redemptions: true } } } });
    if (!c) throw notFound('Coupon');
    // Used coupons are kept for the billing trail; they are deactivated instead.
    if (c._count.redemptions > 0) {
      await tx.coupon.update({ where: { id }, data: { active: false } });
      await audit(tx, ctx, { action: 'coupon.deactivated', targetType: 'coupon', targetId: id, organizationId: null, metadata: { code: c.code } });
      return { deleted: false, deactivated: true };
    }
    await tx.coupon.delete({ where: { id } });
    await audit(tx, ctx, { action: 'coupon.deleted', targetType: 'coupon', targetId: id, organizationId: null, metadata: { code: c.code } });
    return { deleted: true, deactivated: false };
  });
}

export async function couponRedemptions(id: string) {
  return withPlatform(async (tx) => {
    const rows = await tx.couponRedemption.findMany({ where: { couponId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
    const [orgs, reqs] = await Promise.all([
      tx.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.organizationId))] } }, select: { id: true, name: true } }),
      tx.leadRequest.findMany({ where: { id: { in: rows.map((r) => r.requestId) } }, select: { id: true, code: true, status: true, deliveredCount: true, total: true } }),
    ]);
    return rows.map((r) => ({ ...r, discount: Number(r.discount), organization: orgs.find((o) => o.id === r.organizationId)?.name ?? '—', request: reqs.map((x) => ({ ...x, total: Number(x.total) })).find((x) => x.id === r.requestId) ?? null }));
  });
}

// ── Eligibility ────────────────────────────────────────────────────

/** Why a coupon cannot be used right now (null when it can). */
async function ineligibility(tx: Tx, c: Coupon, orgId: string, opts: { leadCount?: number; subtotalCents?: number }) {
  const now = new Date();
  if (!c.active) return 'This coupon is no longer active';
  if (c.startsAt && c.startsAt > now) return `This coupon starts on ${c.startsAt.toISOString().slice(0, 10)}`;
  if (c.endsAt && c.endsAt <= now) return 'This coupon has expired';
  if (c.organizationIds.length && !c.organizationIds.includes(orgId)) return 'This coupon is not available for your workspace';
  const counted = { couponId: c.id, requestId: { in: (await tx.leadRequest.findMany({ where: { couponId: c.id, status: ACTIVE_REQUEST }, select: { id: true } })).map((r) => r.id) } };
  if (c.maxRedemptions != null && (await tx.couponRedemption.count({ where: counted })) >= c.maxRedemptions) return 'This coupon has been fully redeemed';
  if ((await tx.couponRedemption.count({ where: { ...counted, organizationId: orgId } })) >= c.perClientLimit) return c.perClientLimit === 1 ? 'You have already used this coupon' : `You have used this coupon ${c.perClientLimit} times already`;
  if (c.firstRequestOnly && (await tx.leadRequest.count({ where: { organizationId: orgId, status: ACTIVE_REQUEST } })) > 0) return 'This coupon is for your first request only';
  if (opts.leadCount != null && c.minLeads > 0 && opts.leadCount < c.minLeads) return `Request at least ${c.minLeads} leads to use this coupon`;
  if (opts.subtotalCents != null && Number(c.minSubtotal) > 0 && opts.subtotalCents < Number(c.minSubtotal) * 100) return `The order must be at least ${Number(c.minSubtotal).toFixed(2)} before discounts`;
  return null;
}

/**
 * Looks up a code for a workspace. Returns the coupon or a reason. Pass `lock` inside a write transaction so
 * concurrent requests cannot both take the last redemption.
 */
export async function resolveCoupon(tx: Tx, code: string, orgId: string, opts: { leadCount?: number; subtotalCents?: number; lock?: boolean } = {}) {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return { coupon: null, error: null };
  if (opts.lock) await tx.$queryRaw`SELECT id FROM coupons WHERE code = ${normalized} FOR UPDATE`;
  const c = await tx.coupon.findUnique({ where: { code: normalized } });
  if (!c) return { coupon: null, error: 'That coupon code is not valid' };
  const why = await ineligibility(tx, c, orgId, opts);
  return why ? { coupon: null, error: why } : { coupon: c, error: null };
}

/** Coupons a workspace can use now (visible ones only — private codes still work when typed). */
export async function availableCoupons(orgId: string) {
  return withPlatform(async (tx) => {
    const now = new Date();
    const rows = await tx.coupon.findMany({
      where: { active: true, visibleToClients: true, OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] },
      orderBy: [{ endsAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
    const out = [];
    for (const c of rows) {
      if (await ineligibility(tx, c, orgId, {})) continue;
      out.push({ code: c.code, name: c.name, description: c.description, type: c.type, value: Number(c.value), maxDiscount: c.maxDiscount == null ? null : Number(c.maxDiscount), minLeads: c.minLeads, minSubtotal: Number(c.minSubtotal), endsAt: c.endsAt, firstRequestOnly: c.firstRequestOnly });
    }
    return out;
  });
}

/** Records (or replaces) the redemption that belongs to a request. */
export async function recordRedemption(tx: Tx, input: { couponId: string; organizationId: string; requestId: string; discount: number; extraFreeLeads: number }) {
  await tx.couponRedemption.upsert({ where: { requestId: input.requestId }, create: input, update: { discount: input.discount, extraFreeLeads: input.extraFreeLeads } });
}

export async function releaseRedemption(tx: Tx, requestId: string) {
  await tx.couponRedemption.deleteMany({ where: { requestId } });
}

