import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CREDIT_SETTINGS } from '@/lib/credits';
import { DEFAULT_FINANCE, financialYear, gstSplit } from '@/lib/finance';
import { DEFAULT_PRICING, type Pricing } from '@/lib/pricing';
import { withPlatform } from '@/server/db';
import { evaluateAlertRules, measure, saveAlertRule } from '@/server/services/alerts-admin';
import { adjustCredits, completeCreditRequest, createCreditRequest, saveCreditSettings } from '@/server/services/credits';
import { getInvoice, issueInvoice, listInvoices, saveFinance } from '@/server/services/finance';
import { clientHealth, orgTimeline } from '@/server/services/health';
import { demandInsights, inventoryInsights, logMarketSearch, receivables, revenueInsights } from '@/server/services/insights';
import { createLeadRequest, savePricing, setBillingStatus } from '@/server/services/marketplace';
import { handleRazorpayWebhook, paymentSignature, verifyPayment, webhookSignature } from '@/server/services/payments';
import { pullSupplierStock, saveSupplier, supplierPerformance } from '@/server/services/suppliers';
import { ctxFor, ensureRoles, makeLeads, makeOrg, makeUser } from '../helpers';

let admin: Awaited<ReturnType<typeof ctxFor>>;
const pricing: Pricing = { ...DEFAULT_PRICING, basePrice: 100, minPrice: 0, freeLeadsPerClient: 0, taxPct: 18, volumeTiers: [], rules: [], overrides: [], autoApproveFree: true, autoApprovePaid: true, dynamic: { ...DEFAULT_PRICING.dynamic, enabled: false } };

beforeAll(async () => {
  await ensureRoles();
  admin = await ctxFor((await makeUser('platform_owner', null)).id);
  await savePricing(admin, pricing);
  await saveCreditSettings(admin, { ...DEFAULT_CREDIT_SETTINGS, creditValue: 1, spendDiscountPct: 0, taxPct: 18, autoDeliver: true, welcomeCredits: 0, lowBalanceThreshold: 0, expiryDays: null });
  await saveFinance(admin, { ...DEFAULT_FINANCE, seller: { ...DEFAULT_FINANCE.seller, legalName: 'Leads Co Pvt Ltd', gstin: '27AAACL1234F1Z5', state: '' } });
});
afterAll(async () => {
  await savePricing(admin, DEFAULT_PRICING);
  await saveCreditSettings(admin, DEFAULT_CREDIT_SETTINGS);
  await saveFinance(admin, DEFAULT_FINANCE);
});

async function client(opts: { state?: string } = {}) {
  const org = await makeOrg();
  if (opts.state) await withPlatform((tx) => tx.organization.update({ where: { id: org.id }, data: { billingState: opts.state, gstin: opts.state === 'Maharashtra' ? '27BBBCL1234F1Z5' : '29BBBCL1234F1Z5' } }));
  const owner = await makeUser('client_owner', org.id);
  return { org, owner, ctx: await ctxFor(owner.id) };
}

describe('GST invoices', () => {
  it('splits tax by state and numbers invoices per financial year', () => {
    expect(gstSplit(1800, 'Maharashtra', 'Maharashtra')).toEqual({ cgst: 900, sgst: 900, igst: 0 });
    expect(gstSplit(1801, 'Maharashtra', 'Karnataka')).toEqual({ cgst: 0, sgst: 0, igst: 1801 });
    expect(financialYear(new Date('2026-03-31T10:00:00'))).toBe('2025-26');
    expect(financialYear(new Date('2026-04-01T10:00:00'))).toBe('2026-27');
  });

  it('invoices credit purchases (CGST+SGST in-state) and invoiced lead purchases (IGST out of state), never credit-paid leads', async () => {
    const a = await client({ state: 'Maharashtra' });
    const cr = await createCreditRequest(a.ctx, { credits: 1000 });
    await completeCreditRequest(admin, cr.id, { paymentMethod: 'UPI' });
    const inv = (await listInvoices(a.ctx, { page: 1, pageSize: 10 })).rows;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ kind: 'CREDIT_PURCHASE', taxable: 1000, cgst: 90, sgst: 90, igst: 0, total: 1180, paid: true });
    expect(inv[0].number).toMatch(/^INV\/\d{4}-\d{2}\/\d{4}$/);
    expect((inv[0].seller as { state: string }).state).toBe('Maharashtra'); // derived from the GSTIN
    expect(await issueInvoice('CREDIT_PURCHASE', cr.id)).toMatchObject({ id: inv[0].id }); // idempotent

    const b = await client({ state: 'Karnataka' });
    const r = await createLeadRequest(b.ctx, { selection: { mode: 'ids', ids: await makeLeads(2) }, acceptCharges: true, paymentMethod: 'INVOICE' });
    const li = (await listInvoices(b.ctx, { page: 1, pageSize: 10 })).rows[0];
    expect(li).toMatchObject({ kind: 'LEAD_PURCHASE', taxable: 200, igst: 36, cgst: 0, total: 236, paid: false });
    await setBillingStatus(admin, r.id, 'PAID');
    expect((await getInvoice(b.ctx, li.id)).paid).toBe(true);
    await expect(getInvoice(a.ctx, li.id)).rejects.toThrow(/not found/i); // other workspace

    await adjustCredits(admin, { organizationId: b.org.id, credits: 500, reason: 'Top up' });
    await createLeadRequest(b.ctx, { selection: { mode: 'ids', ids: await makeLeads(1) }, acceptCharges: true, paymentMethod: 'CREDITS' });
    expect((await listInvoices(b.ctx, { page: 1, pageSize: 10 })).total).toBe(1);
  });
});

describe('Razorpay', () => {
  it('verifies the checkout signature and completes the credit purchase once', async () => {
    process.env.RAZORPAY_KEY_SECRET = 'test_secret_123';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'wh_secret_456';
    const { org, ctx } = await client();
    const cr = await createCreditRequest(ctx, { credits: 200 });
    await withPlatform((tx) => tx.paymentOrder.create({ data: { providerOrderId: `order_${cr.id}`, creditRequestId: cr.id, organizationId: org.id, amount: cr.total, currency: cr.currency, createdById: ctx.user.id } }));
    await expect(verifyPayment(ctx, { orderId: `order_${cr.id}`, paymentId: 'pay_1', signature: 'f'.repeat(64) })).rejects.toThrow(/could not be verified/);
    // A failed attempt is recorded; a real one still settles.
    await withPlatform((tx) => tx.paymentOrder.updateMany({ where: { providerOrderId: `order_${cr.id}` }, data: { status: 'CREATED' } }));
    const ok = await verifyPayment(ctx, { orderId: `order_${cr.id}`, paymentId: 'pay_1', signature: paymentSignature(`order_${cr.id}`, 'pay_1', 'test_secret_123') });
    expect(ok).toMatchObject({ status: 'PAID', already: false });
    const done = await withPlatform((tx) => tx.creditRequest.findUniqueOrThrow({ where: { id: cr.id } }));
    expect(done).toMatchObject({ status: 'COMPLETED', paymentReference: 'pay_1' });
    // The webhook for the same payment is a no-op.
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: `order_${cr.id}` } } } });
    await expect(handleRazorpayWebhook(body, 'bad')).rejects.toThrow(/Invalid signature/);
    expect(await handleRazorpayWebhook(body, webhookSignature(body, 'wh_secret_456'))).toMatchObject({ already: true });
    expect(await withPlatform((tx) => tx.creditEntry.count({ where: { organizationId: org.id, type: 'PURCHASE' } }))).toBe(1);
  });
});

describe('suppliers, insights, health, alerts', () => {
  it('measures supplier profit and pulls unsold stock', async () => {
    const src = `Vendor-${Date.now()}`;
    const s = await saveSupplier(admin, null, { name: 'Test Vendor', sources: [src], costPerLead: 30, currency: 'INR', status: 'ACTIVE' });
    const { ctx } = await client();
    const ids = await makeLeads(4);
    await withPlatform((tx) => tx.lead.updateMany({ where: { id: { in: ids } }, data: { source: src } }));
    await createLeadRequest(ctx, { selection: { mode: 'ids', ids: ids.slice(0, 2) }, acceptCharges: true, paymentMethod: 'INVOICE' });
    const p = (await supplierPerformance({ days: 30 })).suppliers.find((x) => x.id === s.id)!;
    expect(p).toMatchObject({ imported: 4, sold: 2, available: 2, revenue: 200, cost: 120, profit: 80, sellThrough: 50 });
    expect(await pullSupplierStock(admin, s.id)).toEqual({ archived: 2 });
  });

  it('reports revenue, inventory, demand and receivables', async () => {
    const { ctx } = await client();
    await logMarketSearch(ctx, { conditions: [{ field: 'industry', op: 'in', value: ['Space Mining'] }] }, 0);
    const d = await demandInsights({ days: 7 });
    expect(d.unmet.industries.some((x) => x.value === 'Space Mining')).toBe(true);
    const r = await revenueInsights({ days: 30 });
    expect(r.totals.gross).toBeGreaterThan(0);
    expect(r.series.length).toBeGreaterThanOrEqual(30);
    const inv = await inventoryInsights();
    expect(inv.total).toBeGreaterThanOrEqual(0);
    expect(inv.aging.reduce((a, b) => a + b.count, 0)).toBe(inv.total);
    expect((await receivables()).buckets).toHaveLength(4);
  });

  it('scores client health with reasons and builds an account timeline', async () => {
    const { org, ctx } = await client();
    await adjustCredits(admin, { organizationId: org.id, credits: 50, reason: 'Goodwill' });
    const [h] = await clientHealth({ organizationId: org.id });
    expect(h).toMatchObject({ organizationId: org.id, status: expect.stringMatching(/healthy|watch|at_risk/) });
    expect(h.reasons.some((x) => /signed in/.test(x.text))).toBe(true);
    const t = await orgTimeline(org.id);
    expect(t.items.some((i) => i.kind === 'credits' && i.title.includes('+50'))).toBe(true);
    void ctx;
  });

  it('fires an alert rule once per entity per cooldown', async () => {
    const { org } = await client();
    await adjustCredits(admin, { organizationId: org.id, credits: 5, reason: 'Tiny' });
    const rule = await saveAlertRule(admin, null, { name: 'Low credits', metric: 'client_credits_below', threshold: 10, params: {}, cooldownHours: 24, email: false, active: true });
    expect((await measure('client_credits_below', 10, {})).some((h) => h.key === org.id)).toBe(true);
    await evaluateAlertRules();
    await evaluateAlertRules();
    const events = await withPlatform((tx) => tx.alertRuleEvent.findMany({ where: { ruleId: rule.id, title: { contains: '' } } }));
    expect(events.filter((e) => e.title.includes('low on credits')).length).toBeGreaterThanOrEqual(1);
    const mine = events.filter((e) => e.body.includes('5 credits left'));
    expect(mine).toHaveLength(1);
    await withPlatform((tx) => tx.alertRule.delete({ where: { id: rule.id } }));
  });
});
