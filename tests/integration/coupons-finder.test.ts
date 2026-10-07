import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PRICING } from '@/lib/pricing';
import { withPlatform } from '@/server/db';
import { availableCoupons, saveCoupon } from '@/server/services/coupons';
import { emptyCriteria, finderTurn, understand } from '@/server/services/lead-finder';
import { createLeadRequest, quoteRequest, rejectLeadRequest, savePricing } from '@/server/services/marketplace';
import { ctxFor, ensureRoles, makeLeads, makeOrg, makeUser } from '../helpers';

let admin: { id: string };
beforeAll(async () => {
  await ensureRoles();
  admin = await makeUser('platform_owner', null);
  await savePricing(await ctxFor(admin.id), { ...DEFAULT_PRICING, basePrice: 10, freeLeadsPerClient: 0, taxPct: 0, volumeTiers: [], rules: [], autoApproveFree: true, autoApprovePaid: false, dynamic: { ...DEFAULT_PRICING.dynamic, enabled: false } });
});
async function client() {
  const org = await makeOrg();
  const owner = await makeUser('client_owner', org.id);
  return { org, ctx: await ctxFor(owner.id) };
}
const coupon = async (over: Record<string, unknown> = {}) =>
  saveCoupon(await ctxFor(admin.id), null, { code: `C${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name: 'Test', type: 'PERCENT', value: 50, minLeads: 0, minSubtotal: 0, perClientLimit: 1, organizationIds: [], visibleToClients: true, firstRequestOnly: false, active: true, ...over } as never);

// Pricing is platform-wide: restore the defaults for later test files.
afterAll(async () => {
  await savePricing(await ctxFor(admin.id), DEFAULT_PRICING);
});

describe('coupons', () => {
  it('lists eligible coupons to clients and discounts their quote', async () => {
    const { ctx } = await client();
    const c = await coupon();
    const hidden = await coupon({ visibleToClients: false, type: 'FIXED', value: 15 });
    const codes = (await availableCoupons(ctx.orgId!)).map((x) => x.code);
    expect(codes).toContain(c.code);
    expect(codes).not.toContain(hidden.code);
    const ids = await makeLeads(4);
    const q = await quoteRequest(ctx, { mode: 'ids', ids }, c.code);
    expect(q.coupon?.error).toBeNull();
    expect(q.quote.subtotalCents).toBe(4000);
    expect(q.quote.couponDiscountCents).toBe(2000);
    expect(q.quote.totalCents).toBe(2000);
    // Private codes still work when typed.
    expect((await quoteRequest(ctx, { mode: 'ids', ids }, hidden.code.toLowerCase())).quote.couponDiscountCents).toBe(1500);
    expect((await quoteRequest(ctx, { mode: 'ids', ids }, 'NOPE-123')).coupon?.error).toMatch(/not valid/);
  });

  it('enforces per-client limits, releases on rejection and honours scope, dates and minimums', async () => {
    const { ctx } = await client();
    const other = await client();
    const c = await coupon({ organizationIds: [ctx.orgId], minLeads: 2 });
    const r = await createLeadRequest(ctx, { selection: { mode: 'ids', ids: await makeLeads(2) }, acceptCharges: true, couponCode: c.code });
    expect(Number(r.total)).toBe(10);
    expect(Number(r.couponDiscount)).toBe(10);
    await expect(createLeadRequest(ctx, { selection: { mode: 'ids', ids: await makeLeads(2) }, acceptCharges: true, couponCode: c.code })).rejects.toThrow(/already used/);
    await rejectLeadRequest(await ctxFor(admin.id), r.id, 'Testing release');
    expect((await quoteRequest(ctx, { mode: 'ids', ids: await makeLeads(2) }, c.code)).coupon?.error).toBeNull();
    expect((await quoteRequest(ctx, { mode: 'ids', ids: await makeLeads(1) }, c.code)).coupon?.error).toMatch(/at least 2/);
    expect((await quoteRequest(other.ctx, { mode: 'ids', ids: await makeLeads(2) }, c.code)).coupon?.error).toMatch(/not available for your workspace/);
    const expired = await coupon({ startsAt: new Date(Date.now() - 2 * 86400_000), endsAt: new Date(Date.now() - 86400_000) });
    expect((await quoteRequest(ctx, { mode: 'ids', ids: await makeLeads(1) }, expired.code)).coupon?.error).toMatch(/expired/);
    expect((await availableCoupons(ctx.orgId!)).map((x) => x.code)).not.toContain(expired.code);
  });

  it('gives extra free leads with a free-lead coupon and stops at the redemption cap', async () => {
    const a = await client();
    const b = await client();
    const c = await coupon({ type: 'FREE_LEADS', value: 3, maxRedemptions: 1 });
    const ids = await makeLeads(5);
    const q = await quoteRequest(a.ctx, { mode: 'ids', ids }, c.code);
    expect(q.quote.couponFreeLeads).toBe(3);
    expect(q.quote.totalCents).toBe(2000);
    const r = await createLeadRequest(a.ctx, { selection: { mode: 'ids', ids }, acceptCharges: true, couponCode: c.code });
    expect(r.freeApplied).toBe(3);
    expect(await withPlatform((tx) => tx.couponRedemption.count({ where: { couponId: c.id } }))).toBe(1);
    expect((await quoteRequest(b.ctx, { mode: 'ids', ids: await makeLeads(1) }, c.code)).coupon?.error).toMatch(/fully redeemed/);
  });
});

describe('lead finder', () => {
  const vocab = {
    industries: [{ value: 'Real Estate', count: 9 }, { value: 'Insurance', count: 5 }, { value: 'Solar & Energy', count: 3 }],
    countries: [{ value: 'United States', count: 9 }, { value: 'United Kingdom', count: 3 }, { value: 'India', count: 2 }],
    states: [{ value: 'California', count: 3 }], cities: [], sources: [{ value: 'Website Form', count: 4 }], campaigns: [],
  };

  it('understands rich natural-language requests', () => {
    const { criteria: c, intent } = understand('Find 50 decision makers in real estate in the USA with phone numbers, score above 70', vocab, emptyCriteria(), null);
    expect(c.industries).toEqual(['Real Estate']);
    expect(c.countries).toEqual(['United States']);
    expect(c.seniority.sort()).toEqual(['Director', 'Executive']);
    expect(c.needPhone).toBe(true);
    expect(c.quantity).toBe(50);
    expect(c.minScore).toBe(70);
    expect(intent.changed).toContain('industry');
  });

  it('copes with typos, synonyms, budgets and freshness', () => {
    expect(understand('insurence leads in britain', vocab, emptyCriteria(), null).criteria).toMatchObject({ industries: ['Insurance'], countries: ['United Kingdom'] });
    expect(understand('solar prospects in california', vocab, emptyCriteria(), null).criteria).toMatchObject({ industries: ['Solar & Energy'], states: ['California'] });
    const b = understand('fresh property leads added this week, budget $200, score under 50', vocab, emptyCriteria(), null).criteria;
    expect(b).toMatchObject({ industries: ['Real Estate'], freshOnly: true, addedWithinDays: 7, budget: 200, maxScore: 50 });
    expect(understand('hot leads', vocab, emptyCriteria(), null).criteria.minScore).toBe(80);
    expect(understand('help us find leads', vocab, emptyCriteria(), null).criteria.countries).toEqual([]);
    expect(understand('start over', vocab, { ...emptyCriteria(), industries: ['Insurance'] }, null).intent.reset).toBe(true);
  });

  it('asks a question when vague and shows masked matches when specific', async () => {
    const { ctx } = await client();
    await makeLeads(3, { industry: 'Zeta Robotics', country: 'Norway', score: 88 });
    const start = await finderTurn(ctx, { message: null, action: { type: 'start' }, criteria: emptyCriteria(), history: [] });
    expect(start.reply).toMatch(/Lead Finder/);
    expect(start.faq.length).toBeGreaterThan(3);
    const r = await finderTurn(ctx, { message: 'zeta robotics leads in norway', action: null, criteria: emptyCriteria(), history: [] });
    expect(r.criteria.industries).toEqual(['Zeta Robotics']);
    expect(r.results?.total).toBe(3);
    expect(r.results?.filter.conditions).toEqual(expect.arrayContaining([{ field: 'industry', op: 'in', value: ['Zeta Robotics'] }]));
    expect(JSON.stringify(r.results?.sample)).not.toMatch(/fullName|@example|\+1415/);
    // Impossible combination → suggestions to relax.
    const india = await finderTurn(ctx, { message: 'zeta robotics in brazil', action: null, criteria: emptyCriteria(), history: [] });
    expect(india.reply).toMatch(/no leads from Brazil/);
    const none = await finderTurn(ctx, { message: 'zeta robotics in norway with score above 95', action: null, criteria: emptyCriteria(), history: [] });
    expect(none.results?.total).toBe(0);
    expect(none.results?.relax.map((x) => x.label).join()).toMatch(/score/);
    const faq = await finderTurn(ctx, { message: null, action: { type: 'faq', id: 'visibility' }, criteria: emptyCriteria(), history: [] });
    expect(faq.reply).toMatch(/My leads/);
  });
});
