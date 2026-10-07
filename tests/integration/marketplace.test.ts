import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as requestGET } from '@/app/api/v1/marketplace/requests/[id]/route';
import { DEFAULT_PRICING, type Pricing } from '@/lib/pricing';
import { withPlatform, withTenant } from '@/server/db';
import { announceNewLeads, broadcast } from '@/server/services/announcements';
import {
  billingSummary, cancelLeadRequest, createLeadRequest, fulfillLeadRequest, listCatalog, listLeadRequests, quoteRequest, rejectLeadRequest, savePricing, setBillingStatus,
} from '@/server/services/marketplace';
import { cookieFor, ctxFor, ensureRoles, makeLeads, makeOrg, makeUser, req } from '../helpers';

let admin: { id: string };
const pricing: Pricing = { ...DEFAULT_PRICING, basePrice: 10, minPrice: 0, freeLeadsPerClient: 10, taxPct: 10, volumeTiers: [{ minQty: 5, discountPct: 20 }], autoApproveFree: true, autoApprovePaid: false, dynamic: { ...DEFAULT_PRICING.dynamic, enabled: false }, rules: [{ id: 'ins', name: 'Insurance', enabled: true, conditions: [{ field: 'industry', op: 'in', value: ['Insurance'] }], action: 'SET', amount: 25 }], overrides: [] };

beforeAll(async () => {
  await ensureRoles();
  admin = await makeUser('platform_owner', null);
  await savePricing(await ctxFor(admin.id), pricing);
});

async function client() {
  const org = await makeOrg();
  const owner = await makeUser('client_owner', org.id);
  return { org, owner, ctx: await ctxFor(owner.id) };
}
const status = (ids: string[]) => withPlatform((tx) => tx.lead.findMany({ where: { id: { in: ids } }, select: { id: true, allocationStatus: true, assignedOrganizationId: true } }));

// Pricing is platform-wide: restore the defaults for later test files.
afterAll(async () => {
  await savePricing(await ctxFor(admin.id), DEFAULT_PRICING);
});

describe('lead marketplace', () => {
  it('lists available leads without any identifying details, ignoring unsafe filters', async () => {
    const { ctx } = await client();
    const [lead] = await makeLeads(1, { industry: 'Marketplace-Mask-Test', country: 'Canada' });
    await withPlatform((tx) => tx.lead.update({ where: { id: lead }, data: { company: 'Hidden Widgets Ltd', jobTitle: 'Head of Sales' } }));
    const res = await listCatalog(ctx, { filter: { q: 'Lead 0', conditions: [{ field: 'industry', op: 'in', value: ['Marketplace-Mask-Test'] }, { field: 'fullName', op: 'contains', value: 'Lead' }] }, page: 1, pageSize: 50 });
    expect(res.rows.map((r) => r.id)).toEqual([lead]);
    const json = JSON.stringify(res.rows[0]);
    // The company name is shown (Admin → Pricing → Company preview); people's names, titles and contacts never are.
    expect(res.rows[0].company?.name).toBe('Hidden Widgets Ltd');
    for (const leak of ['fullName', 'Lead 0', 'email"', 'phone"', 'jobTitle', 'Head of Sales', '@example.test', '+1415']) expect(json).not.toContain(leak);
    expect(res.rows[0]).toMatchObject({ country: 'Canada', hasEmail: true, hasPhone: true, priceCents: 1000 });
  });

  it('gives each workspace free demo leads, delivered instantly', async () => {
    const { org, ctx } = await client();
    const ids = await makeLeads(3);
    const q = await quoteRequest(ctx, { mode: 'ids', ids });
    expect(q.quote.totalCents).toBe(0);
    expect(q.quote.freeApplied).toBe(3);
    expect(q.autoApprove).toBe(true);
    const r = await createLeadRequest(ctx, { selection: { mode: 'ids', ids }, acceptCharges: false });
    expect(r.status).toBe('FULFILLED');
    expect(r.billingStatus).toBe('NONE');
    expect((await status(ids)).every((l) => l.assignedOrganizationId === org.id)).toBe(true);
    const mine = await withTenant(org.id, (tx) => tx.clientLead.count({ where: { organizationId: org.id, leadId: { in: ids } } }));
    expect(mine).toBe(3);
    expect((await billingSummary(ctx)).allowance).toMatchObject({ total: 10, used: 3, remaining: 7 });
  });

  it('prices paid leads with rules, volume tiers and tax; bills only on approval', async () => {
    const { org, ctx } = await client();
    const ids = [...(await makeLeads(12)), ...(await makeLeads(2, { industry: 'Insurance' }))];
    // 14 leads: the 10 free ones go to the most expensive (both $25 insurance leads + 8 standard), 4 standard are paid.
    const q = await quoteRequest(ctx, { mode: 'ids', ids });
    expect(q.quote.freeApplied).toBe(10);
    expect(q.quote.paidCount).toBe(4);
    expect(q.quote.subtotalCents).toBe(4000);
    expect(q.quote.discountCents).toBe(0); // tier needs 5 paid leads
    expect(q.quote.taxCents).toBe(400);
    expect(q.quote.totalCents).toBe(4400);
    expect(q.autoApprove).toBe(false);

    await expect(createLeadRequest(ctx, { selection: { mode: 'ids', ids }, acceptCharges: false })).rejects.toThrow(/confirm the charges/);
    const r = await createLeadRequest(ctx, { selection: { mode: 'ids', ids }, acceptCharges: true, note: 'Q4 push' });
    expect(r.status).toBe('PENDING');
    // Reserved: no longer offered to anyone else.
    expect((await status(ids)).every((l) => l.allocationStatus === 'PENDING')).toBe(true);
    const other = await client();
    expect((await quoteRequest(other.ctx, { mode: 'ids', ids })).available).toBe(0);

    const done = await fulfillLeadRequest(await ctxFor(admin.id), r.id);
    expect(done.status).toBe('FULFILLED');
    expect(done.deliveredCount).toBe(14);
    expect(done.billingStatus).toBe('DUE');
    expect(done.invoiceNumber).toMatch(/^INV-/);
    expect(Number(done.total)).toBe(44);
    expect((await status(ids)).every((l) => l.assignedOrganizationId === org.id)).toBe(true);
    expect((await billingSummary(ctx)).outstanding).toBe(44);

    await setBillingStatus(await ctxFor(admin.id), r.id, 'PAID');
    const s = await billingSummary(ctx);
    expect(s.outstanding).toBe(0);
    expect(s.paid).toBe(44);
    expect(s.allowance.remaining).toBe(0);
  });

  it('applies volume discounts and releases leads when a request is rejected or cancelled', async () => {
    const { ctx } = await client();
    await createLeadRequest(ctx, { selection: { mode: 'ids', ids: await makeLeads(10) }, acceptCharges: false }); // use up the free allowance
    const ids = await makeLeads(6);
    const q = await quoteRequest(ctx, { mode: 'ids', ids });
    expect(q.quote.tierPct).toBe(20);
    expect(q.quote.totalCents).toBe(Math.round(6000 * 0.8 * 1.1));
    const r = await createLeadRequest(ctx, { selection: { mode: 'ids', ids }, acceptCharges: true });
    await rejectLeadRequest(await ctxFor(admin.id), r.id, 'Out of budget for this client');
    expect((await status(ids)).every((l) => l.allocationStatus === 'UNALLOCATED')).toBe(true);

    const again = await createLeadRequest(ctx, { selection: { mode: 'ids', ids: ids.slice(0, 2) }, acceptCharges: true });
    const intruder = await client();
    await expect(cancelLeadRequest(intruder.ctx, again.id)).rejects.toThrow(/not found/i);
    await cancelLeadRequest(ctx, again.id);
    expect((await status(ids.slice(0, 2))).every((l) => l.allocationStatus === 'UNALLOCATED')).toBe(true);
  });

  it('keeps requests private to their workspace', async () => {
    const a = await client();
    const b = await client();
    const r = await createLeadRequest(a.ctx, { selection: { mode: 'ids', ids: await makeLeads(1) }, acceptCharges: false });
    expect((await requestGET(req('/x', { cookie: await cookieFor(b.owner.id) }), { params: Promise.resolve({ id: r.id }) })).status).toBe(404);
    expect((await listLeadRequests(b.ctx, { page: 1, pageSize: 50 })).rows.some((x) => x.id === r.id)).toBe(false);
    expect((await listLeadRequests(a.ctx, { page: 1, pageSize: 50 })).rows.map((x) => x.id)).toContain(r.id);
  });
});

describe('announcements', () => {
  it('notifies client dashboards about new leads automatically, once', async () => {
    const { owner } = await client();
    await makeLeads(4, { industry: 'Announce-Test' });
    const a = await announceNewLeads();
    expect(a?.kind).toBe('NEW_LEADS');
    expect(a?.title).toMatch(/new leads? (is|are) available/);
    const n = await withPlatform((tx) => tx.notification.findFirst({ where: { userId: owner.id, type: 'NEW_LEADS' } }));
    expect(n?.link).toBe('/app/marketplace?sort=new');
    expect(await announceNewLeads()).toBeNull(); // nothing new since
  });

  it('broadcasts to selected workspaces only', async () => {
    const a = await client();
    const b = await client();
    const sent = await broadcast(await ctxFor(admin.id), { title: 'Maintenance on Sunday', body: 'Short downtime', link: '/app', scope: 'ORGS', organizationIds: [a.org.id], marketplaceOnly: false });
    expect(sent.orgCount).toBe(1);
    const got = async (userId: string) => withPlatform((tx) => tx.notification.count({ where: { userId, type: 'ANNOUNCEMENT', title: 'Maintenance on Sunday' } }));
    expect(await got(a.owner.id)).toBe(1);
    expect(await got(b.owner.id)).toBe(0);
  });
});

describe('dynamic marketplace pricing', () => {
  it('prices each lead by its information, research, age and resales, and explains it to clients', async () => {
    const admin2 = await ctxFor(admin.id);
    const dynamic = { ...DEFAULT_PRICING.dynamic, enabled: true, showBreakdown: true, research: { enabled: true, maxPct: 20, minConfidence: 40 }, age: { enabled: true, graceDays: 7, everyDays: 30, pct: 10, floorPct: 40 }, transfers: { enabled: true, pct: 15, floorPct: 30 } };
    await savePricing(admin2, { ...pricing, rules: [], dynamic });
    try {
      const { ctx } = await client();
      const tag = `Dyn-${Date.now()}`;
      const [rich, bare, old, resold] = await makeLeads(4, { industry: tag, country: 'India' });
      await withPlatform(async (tx) => {
        await tx.lead.update({ where: { id: rich }, data: { company: 'Sunrise Exports Pvt Ltd', jobTitle: 'Director of Sales', city: 'Pune', emailNormalized: 'buyer@sunrise-exports.test' } });
        await tx.leadEnrichment.create({ data: { leadId: rich, status: 'DONE', confidence: 90, domain: 'sunrise-exports.test', finishedAt: new Date(), checks: { crawl: { status: 'ok' } }, data: {
          companyName: { value: 'Sunrise Exports Pvt Ltd', confidence: 95 }, description: { value: 'Exports textiles.', confidence: 85 }, companySize: { value: '51-200', confidence: 80 },
          linkedin: { value: 'https://www.linkedin.com/company/sunrise-exports', confidence: 80 }, companyPhone: { value: '+91 20 5555 0100', confidence: 90 }, companyEmail: { value: 'info@sunrise-exports.test', confidence: 90 },
        } } });
        await tx.lead.update({ where: { id: bare }, data: { emailNormalized: null, phoneNormalized: null } });
        await tx.lead.update({ where: { id: old }, data: { createdAt: new Date(Date.now() - 400 * 86400_000) } });
        await tx.lead.update({ where: { id: resold }, data: { distributionCount: 2 } });
      });
      const res = await listCatalog(ctx, { filter: { conditions: [{ field: 'industry', op: 'in', value: [tag] }] }, page: 1, pageSize: 10 });
      const by = Object.fromEntries(res.rows.map((r) => [r.id, r]));
      // bare: base + industry 5% = 10.50; others have email 10% + business email 15% + phone 15% + industry 5% = 14.50; resold × 0.85²; old: floor 40%.
      expect(by[bare].priceCents).toBe(1050);
      expect(by[resold].priceCents).toBe(Math.round(1450 * 0.85 ** 2));
      expect(by[old].priceCents).toBe(580);
      expect(by[rich].priceCents).toBeGreaterThan(by[resold].priceCents);
      // Clients see the total only — never how it was worked out.
      for (const row of res.rows) {
        expect(row).not.toHaveProperty('priceSteps');
        expect(row).not.toHaveProperty('pricing');
        expect(JSON.stringify(row)).not.toMatch(/Information value|Research quality|Standard price|Sold before/);
      }
      // Research score per lead, sortable (researched first).
      expect(by[rich].research).toMatchObject({ score: 90, status: 'DONE' });
      expect(by[bare].research).toBeNull();
      const sorted = await listCatalog(ctx, { filter: { conditions: [{ field: 'industry', op: 'in', value: [tag] }] }, sort: { id: 'research', desc: true }, page: 1, pageSize: 10 });
      expect(sorted.rows[0].id).toBe(rich);
      // All company basics are shown, contact details never are.
      expect(by[rich].company).toMatchObject({ name: 'Sunrise Exports Pvt Ltd', website: 'https://sunrise-exports.test', linkedin: 'https://www.linkedin.com/company/sunrise-exports', size: '51-200' });
      const json = JSON.stringify(by[rich]);
      for (const leak of ['buyer@', '+91 20', 'info@sunrise', '+1415', 'Lead 0', 'Director of Sales']) expect(json).not.toContain(leak);
      // The quote charges exactly the listed prices.
      const q = await quoteRequest(ctx, { mode: 'ids', ids: [rich, bare, old, resold] });
      expect(q.quote.lines.every((l) => l.label === 'Marketplace lead')).toBe(true);
      expect(q.quote.lines.flatMap((l) => Array(l.qty).fill(l.unitCents)).sort()).toEqual(res.rows.map((r) => r.priceCents).sort());
      // Admin impact preview re-prices the catalog with unsaved settings.
      const { pricingImpact } = await import('@/server/services/marketplace');
      const impact = await pricingImpact({ ...pricing, rules: [], dynamic: { ...dynamic, enabled: false } });
      expect(impact.sampled).toBeGreaterThan(0);
      expect(impact.proposed.max).toBeLessThanOrEqual(impact.current.max);
      // Clients' price list explains dynamic pricing.
      expect((await billingSummary(ctx)).priceList?.rules.map((r) => r.name)).toContain('Older leads cost less');
    } finally {
      await savePricing(admin2, pricing);
    }
  });
});
