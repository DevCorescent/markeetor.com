import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CREDIT_SETTINGS } from '@/lib/credits';
import { DEFAULT_GROWTH } from '@/lib/growth';
import { DEFAULT_PRICING, type Pricing } from '@/lib/pricing';
import { withPlatform, withTenant } from '@/server/db';
import { leadAssistant, myReferral, onboardingChecklist, recordReferral, todayQueue } from '@/server/services/client-tools';
import { adjustCredits, creditSummary, saveCreditSettings } from '@/server/services/credits';
import { decideDispute, disputeEligibility, listDisputes, reportLead } from '@/server/services/disputes';
import { createLeadRequest, savePricing } from '@/server/services/marketplace';
import { roiDashboard } from '@/server/services/roi';
import { createSavedSearch, listSavedSearches, runSavedSearch, saveGrowth, toggleWatch, watchlist } from '@/server/services/saved-searches';
import { autoAssign, emitWebhook, saveAutomation } from '@/server/services/workspace-automation';
import { DEFAULT_WORKSPACE_AUTOMATION } from '@/lib/growth';
import { ctxFor, ensureRoles, makeLeads, makeOrg, makeUser } from '../helpers';

let admin: Awaited<ReturnType<typeof ctxFor>>;
const pricing: Pricing = { ...DEFAULT_PRICING, basePrice: 10, minPrice: 0, freeLeadsPerClient: 0, taxPct: 0, volumeTiers: [], rules: [], overrides: [], autoApproveFree: true, autoApprovePaid: true, dynamic: { ...DEFAULT_PRICING.dynamic, enabled: false } };

beforeAll(async () => {
  await ensureRoles();
  admin = await ctxFor((await makeUser('platform_owner', null)).id);
  await savePricing(admin, pricing);
  await saveCreditSettings(admin, { ...DEFAULT_CREDIT_SETTINGS, creditValue: 1, spendDiscountPct: 0, autoDeliver: true, allowInvoice: true, welcomeCredits: 0, lowBalanceThreshold: 0, expiryDays: null });
  await saveGrowth(admin, { ...DEFAULT_GROWTH, guarantee: { ...DEFAULT_GROWTH.guarantee, maxReportPct: 100, autoApproveReasons: [] } });
});

async function client(credits = 0) {
  const org = await makeOrg();
  const owner = await makeUser('client_owner', org.id);
  if (credits) await adjustCredits(admin, { organizationId: org.id, credits, reason: 'Test top-up' });
  return { org, owner, ctx: await ctxFor(owner.id) };
}
const clientLeadsOf = (orgId: string, leadIds: string[]) => withTenant(orgId, (tx) => tx.clientLead.findMany({ where: { organizationId: orgId, leadId: { in: leadIds } } }));

// Pricing, credit and growth rules are platform-wide: put the defaults back for later test files.
afterAll(async () => {
  await savePricing(admin, DEFAULT_PRICING);
  await saveCreditSettings(admin, DEFAULT_CREDIT_SETTINGS);
  await saveGrowth(admin, DEFAULT_GROWTH);
});

describe('saved searches & auto-buy', () => {
  it('alerts on new matches only, and auto-buys within the price and weekly limits', async () => {
    const { org, ctx } = await client(100);
    const tag = `SS-${Date.now()}`;
    const old = await makeLeads(2, { industry: tag });
    const s = await createSavedSearch(ctx, { name: 'Test search', filter: { conditions: [{ field: 'industry', op: 'in', value: [tag] }] }, alertInApp: true, alertEmail: false, autoBuy: true, autoBuyMaxPerWeek: 3, autoBuyMaxPrice: 10, active: true });
    expect((await listSavedSearches(ctx)).rows[0]).toMatchObject({ matches: 2, newMatches: 0 });
    // Leads that existed before the search was saved are not "new".
    expect(await runSavedSearch(s.id)).toMatchObject({ newMatches: 0, bought: 0 });
    await withPlatform((tx) => tx.lead.updateMany({ where: { id: { in: old } }, data: { createdAt: new Date(Date.now() - 86400_000) } }));
    const fresh = await makeLeads(5, { industry: tag });
    const r = await runSavedSearch(s.id);
    expect(r).toMatchObject({ newMatches: 5, bought: 3 }); // weekly cap
    expect((await creditSummary(ctx)).balance).toBe(70);
    expect((await clientLeadsOf(org.id, fresh)).length).toBe(3);
    const n = await withPlatform((tx) => tx.notification.count({ where: { userId: ctx.user.id, type: 'SAVED_SEARCH' } }));
    expect(n).toBe(1);
    // Cap reached: next new lead is only alerted.
    await makeLeads(1, { industry: tag });
    expect(await runSavedSearch(s.id)).toMatchObject({ newMatches: 1, bought: 0, note: 'weekly auto-buy limit reached' });
  });

  it('keeps a per-user watchlist that drops leads sold to others', async () => {
    const { ctx } = await client();
    const [a, b] = await makeLeads(2);
    await toggleWatch(ctx, a, true);
    await toggleWatch(ctx, b, true);
    expect((await watchlist(ctx)).rows.map((r) => r.id).sort()).toEqual([a, b].sort());
    await withPlatform((tx) => tx.lead.update({ where: { id: b }, data: { allocationStatus: 'ALLOCATED' } }));
    const w = await watchlist(ctx);
    expect(w.rows.map((r) => r.id)).toEqual([a]);
    expect(w.gone).toBe(1);
  });
});

describe('lead quality guarantee', () => {
  it('refunds approved reports in credits and retires bad leads', async () => {
    const { org, ctx } = await client(50);
    const ids = await makeLeads(2);
    await createLeadRequest(ctx, { selection: { mode: 'ids', ids }, acceptCharges: true, paymentMethod: 'CREDITS' });
    expect((await creditSummary(ctx)).balance).toBe(30);
    const [cl] = await clientLeadsOf(org.id, [ids[0]]);
    expect(await disputeEligibility(ctx, cl.id)).toMatchObject({ eligible: true, windowDays: 7 });
    const d = await reportLead(ctx, cl.id, { reason: 'WRONG_NUMBER', details: 'Number not in service' });
    expect(d).toMatchObject({ status: 'OPEN', paidCredits: 10, refundCredits: 10 });
    await expect(reportLead(ctx, cl.id, { reason: 'OTHER' })).rejects.toThrow(/already been reported/);
    expect((await listDisputes(admin, { status: 'OPEN', page: 1, pageSize: 50 })).rows.some((r) => r.id === d.id)).toBe(true);
    const done = await decideDispute(admin, d.id, { approve: true, resolution: 'Confirmed: number disconnected' });
    expect(done.status).toBe('APPROVED');
    expect((await creditSummary(ctx)).balance).toBe(40);
    expect((await withPlatform((tx) => tx.lead.findUniqueOrThrow({ where: { id: ids[0] } }))).quality).toBe('INVALID');
    await expect(decideDispute(admin, d.id, { approve: true, resolution: 'again' })).rejects.toThrow(/already decided/);
  });

  it('rejected reports refund nothing; leads outside the window or not bought are not covered', async () => {
    const { org, ctx } = await client(50);
    const ids = await makeLeads(2);
    await createLeadRequest(ctx, { selection: { mode: 'ids', ids }, acceptCharges: true, paymentMethod: 'CREDITS' });
    const [a, b] = await clientLeadsOf(org.id, ids);
    const d = await reportLead(ctx, a.id, { reason: 'OTHER', details: 'Not interested' });
    await decideDispute(admin, d.id, { approve: false, resolution: 'Not a quality problem' });
    expect((await creditSummary(ctx)).balance).toBe(30);
    await withTenant(org.id, (tx) => tx.clientLead.update({ where: { id: b.id }, data: { createdAt: new Date(Date.now() - 30 * 86400_000) } }));
    expect(await disputeEligibility(ctx, b.id)).toMatchObject({ eligible: false, reason: expect.stringMatching(/window has passed/) });
  });

  it('can auto-approve chosen reasons', async () => {
    await saveGrowth(admin, { ...DEFAULT_GROWTH, guarantee: { ...DEFAULT_GROWTH.guarantee, maxReportPct: 100, autoApproveReasons: ['BOUNCED_EMAIL'] } });
    try {
      const { org, ctx } = await client(20);
      const ids = await makeLeads(1);
      await createLeadRequest(ctx, { selection: { mode: 'ids', ids }, acceptCharges: true, paymentMethod: 'CREDITS' });
      const [cl] = await clientLeadsOf(org.id, ids);
      expect(await reportLead(ctx, cl.id, { reason: 'BOUNCED_EMAIL' })).toMatchObject({ status: 'APPROVED', autoDecided: true });
      expect((await creditSummary(ctx)).balance).toBe(20);
    } finally {
      await saveGrowth(admin, { ...DEFAULT_GROWTH, guarantee: { ...DEFAULT_GROWTH.guarantee, maxReportPct: 100, autoApproveReasons: [] } });
    }
  });
});

describe('workspace automation', () => {
  it('auto-assigns delivered leads by rule, then round-robin', async () => {
    const { org, owner, ctx } = await client(100);
    const rep = await makeUser('sales_executive', org.id);
    await saveAutomation(ctx, { ...DEFAULT_WORKSPACE_AUTOMATION, autoAssign: { mode: 'rules', memberIds: [owner.id, rep.id], rules: [{ field: 'industry', values: ['Solar'], ownerId: rep.id }], fallback: true } });
    const solar = await makeLeads(2, { industry: 'Solar' });
    const other = await makeLeads(2, { industry: 'Retail' });
    await createLeadRequest(ctx, { selection: { mode: 'ids', ids: [...solar, ...other] }, acceptCharges: true, paymentMethod: 'CREDITS' });
    const got = await clientLeadsOf(org.id, [...solar, ...other]);
    expect(got.filter((l) => solar.includes(l.leadId)).every((l) => l.ownerId === rep.id)).toBe(true);
    expect(got.filter((l) => other.includes(l.leadId)).every((l) => l.ownerId)).toBe(true);
    expect(await autoAssign(org.id, got.map((l) => l.id))).toBe(0); // already owned
  });

  it('enforces member spending limits but not for workspace admins', async () => {
    const { org, ctx } = await client(100);
    await saveAutomation(ctx, { ...DEFAULT_WORKSPACE_AUTOMATION, spending: { maxCreditsPerRequest: 15, monthlyCreditsPerUser: 0, maxAmountPerRequest: 0 } });
    const mgr = await ctxFor((await makeUser('sales_manager', org.id)).id);
    if (!mgr.permissions.has('crm.marketplace.request')) return; // role can't buy at all
    await expect(createLeadRequest(mgr, { selection: { mode: 'ids', ids: await makeLeads(2) }, acceptCharges: true, paymentMethod: 'CREDITS' })).rejects.toThrow(/limits requests to 15/);
    await expect(createLeadRequest(ctx, { selection: { mode: 'ids', ids: await makeLeads(2) }, acceptCharges: true, paymentMethod: 'CREDITS' })).resolves.toBeTruthy();
  });

  it('records webhook deliveries only for subscribed events', async () => {
    const { org, ctx } = await client();
    await saveAutomation(ctx, { ...DEFAULT_WORKSPACE_AUTOMATION, webhooks: [{ id: 'w1', url: 'https://hooks.example.com/leads', events: ['leads.delivered'], secret: 'whsec_0123456789abcdef', active: true }] });
    expect(await emitWebhook(org.id, 'leads.delivered', { count: 1 })).toBe(1);
    expect(await emitWebhook(org.id, 'dispute.decided', {})).toBe(0);
    expect(await withPlatform((tx) => tx.webhookDelivery.count({ where: { organizationId: org.id } }))).toBe(1);
    await expect(saveAutomation(ctx, { ...DEFAULT_WORKSPACE_AUTOMATION, webhooks: [{ id: 'w2', url: 'http://insecure.example.com', events: ['leads.delivered'], secret: 'whsec_0123456789abcdef', active: true }] })).rejects.toThrow();
  });
});

describe('ROI, today queue, assistant, checklist, referrals', () => {
  it('reports spend, funnel, speed-to-lead and revenue', async () => {
    const { org, ctx } = await client(100);
    const ids = await makeLeads(4, { industry: 'ROI-Test' });
    await createLeadRequest(ctx, { selection: { mode: 'ids', ids }, acceptCharges: true, paymentMethod: 'CREDITS' });
    const ls = await clientLeadsOf(org.id, ids);
    await withTenant(org.id, async (tx) => {
      await tx.clientLead.update({ where: { id: ls[0].id }, data: { firstContactAt: new Date(ls[0].createdAt.getTime() + 2 * 3_600_000), status: 'CONVERTED', dealValue: 500 } });
      await tx.clientLead.update({ where: { id: ls[1].id }, data: { firstContactAt: new Date(ls[1].createdAt.getTime() + 4 * 3_600_000), status: 'CONTACTED' } });
    });
    const r = await roiDashboard(ctx, { days: 30 });
    expect(r.spend).toMatchObject({ total: 40, credits: 40 });
    expect(r.funnel).toMatchObject({ leads: 4, purchased: 4, contacted: 2, won: 1 });
    expect(r.value).toMatchObject({ revenue: 500, roi: 12.5, costPerWin: 40 });
    expect(r.speed.medianHours).toBe(3);
    expect(r.byIndustry[0]).toMatchObject({ key: 'ROI-Test', leads: 4, won: 1 });

    const t = await todayQueue(ctx);
    expect(t.counts.uncontacted).toBe(2);
    const a = await leadAssistant(ctx, ls[2].id);
    expect(a.actions[0]).toMatchObject({ urgency: 'now' });
    const draft = await leadAssistant(ctx, ls[2].id, { draft: 'intro' });
    expect(draft.draft?.body).toMatch(/^Hi /);
    expect(draft.draft?.body).not.toMatch(/@|\+1415/);

    const c = await onboardingChecklist(ctx);
    expect(c.steps.find((s) => s.key === 'claim')?.done).toBe(true);
    expect(c.steps.find((s) => s.key === 'contact')?.done).toBe(true);
  });

  it('rewards both workspaces when a referred workspace first buys', async () => {
    const a = await client();
    const ref = await myReferral(a.ctx);
    expect(ref.code).toMatch(/^[0-9A-F]{8}$/);
    const b = await client();
    await recordReferral(b.org.id, ref.code);
    await adjustCredits(admin, { organizationId: b.org.id, credits: 50, reason: 'Top up' });
    await createLeadRequest(b.ctx, { selection: { mode: 'ids', ids: await makeLeads(1) }, acceptCharges: true, paymentMethod: 'INVOICE' });
    expect((await creditSummary(a.ctx)).balance).toBe(DEFAULT_GROWTH.referrals.referrerCredits);
    expect((await creditSummary(b.ctx)).balance).toBe(50 + DEFAULT_GROWTH.referrals.refereeCredits);
    expect((await myReferral(a.ctx)).referrals[0]).toMatchObject({ status: 'REWARDED' });
    // Never twice, and never self-referral.
    await createLeadRequest(b.ctx, { selection: { mode: 'ids', ids: await makeLeads(1) }, acceptCharges: true, paymentMethod: 'INVOICE' });
    expect((await creditSummary(a.ctx)).balance).toBe(DEFAULT_GROWTH.referrals.referrerCredits);
    expect(await recordReferral(a.org.id, ref.code)).toBeNull();
  });
});
