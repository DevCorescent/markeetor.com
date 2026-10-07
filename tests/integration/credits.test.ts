import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { creditCost, DEFAULT_CREDIT_SETTINGS, priceCreditPurchase, type CreditSettings } from '@/lib/credits';
import { DEFAULT_PRICING, type Pricing } from '@/lib/pricing';
import { withPlatform } from '@/server/db';
import {
  adjustCredits, cancelCreditRequest, completeCreditRequest, createCreditRequest, creditOverview, creditSummary, listCreditEntries, listCreditRequests,
  rejectCreditRequest, saveCreditSettings, sendPaymentDetails, submitPaymentReference,
} from '@/server/services/credits';
import { cancelLeadRequest, createLeadRequest, fulfillLeadRequest, quoteRequest, rejectLeadRequest, savePricing } from '@/server/services/marketplace';
import { ctxFor, ensureRoles, makeLeads, makeOrg, makeUser } from '../helpers';

let admin: Awaited<ReturnType<typeof ctxFor>>;
const pricing: Pricing = { ...DEFAULT_PRICING, basePrice: 10, minPrice: 0, freeLeadsPerClient: 0, taxPct: 18, volumeTiers: [], rules: [], overrides: [], autoApproveFree: true, autoApprovePaid: false, dynamic: { ...DEFAULT_PRICING.dynamic, enabled: false } };
const settings: CreditSettings = {
  ...DEFAULT_CREDIT_SETTINGS, enabled: true, costMode: 'price', creditValue: 1, spendDiscountPct: 10, taxPct: 18, expiryDays: null, welcomeCredits: 0,
  lowBalanceThreshold: 0, autoDeliver: true, allowInvoice: true, paymentInstructions: 'UPI: leads@bank',
  packages: [{ id: 'pack', name: 'Pack', description: '', credits: 100, bonusCredits: 20, price: 90, popular: false, enabled: true }],
  custom: { enabled: true, minCredits: 50, maxCredits: 10_000, pricePerCredit: 1 }, bonusTiers: [{ minCredits: 1000, bonusPct: 10 }],
};

beforeAll(async () => {
  await ensureRoles();
  admin = await ctxFor((await makeUser('platform_owner', null)).id);
  await savePricing(admin, pricing);
  await saveCreditSettings(admin, settings);
});

async function client() {
  const org = await makeOrg();
  const owner = await makeUser('client_owner', org.id);
  return { org, ctx: await ctxFor(owner.id) };
}

// Pricing, credit and growth rules are platform-wide: put the defaults back for later test files.
afterAll(async () => {
  await savePricing(admin, DEFAULT_PRICING);
  await saveCreditSettings(admin, DEFAULT_CREDIT_SETTINGS);
});

describe('credit rules', () => {
  it('converts quotes to credits (pre-tax, with the credit discount) and prices purchases', () => {
    expect(creditCost({ totalCents: 11800, taxCents: 1800, paidCount: 10 }, settings)).toBe(90); // 100 × 0.9
    expect(creditCost({ totalCents: 11800, taxCents: 1800, paidCount: 10 }, { ...settings, costMode: 'fixed', fixedCreditsPerLead: 7 })).toBe(63);
    expect(creditCost({ totalCents: 0, taxCents: 0, paidCount: 0 }, settings)).toBe(0);
    expect(creditCost({ totalCents: 1000, taxCents: 0, paidCount: 1 }, { ...settings, overrides: [{ organizationId: 'o1', spendDiscountPct: 50, bonusPct: 0 }] }, 'o1')).toBe(5);
    expect(priceCreditPurchase({ packageId: 'pack' }, settings)).toMatchObject({ credits: 100, bonusCredits: 20, amountCents: 9000, taxCents: 1620, totalCents: 10620 });
    expect(priceCreditPurchase({ credits: 1000 }, settings)).toMatchObject({ credits: 1000, bonusCredits: 100, amountCents: 100000 });
    expect(priceCreditPurchase({ credits: 10 }, settings)).toEqual({ error: expect.stringMatching(/between 50/) });
    expect(priceCreditPurchase({ packageId: 'nope' }, settings)).toEqual({ error: expect.stringMatching(/not available/) });
  });
});

describe('credit purchases', () => {
  it('request → payment details → client reference → payment confirmed → credits added, with history', async () => {
    const { org, ctx } = await client();
    const r = await createCreditRequest(ctx, { packageId: 'pack', note: 'Q4 budget' });
    expect(r).toMatchObject({ status: 'PENDING', credits: 100, bonusCredits: 20, total: 106.2, paymentDetails: 'UPI: leads@bank' });
    await sendPaymentDetails(admin, r.id, 'Pay to UPI leads@bank, ref CR code');
    await submitPaymentReference(ctx, r.id, 'UTR123456');
    expect((await listCreditRequests(admin, { status: 'OPEN', organizationId: org.id, page: 1, pageSize: 10 })).rows[0]).toMatchObject({ status: 'AWAITING_PAYMENT', clientReference: 'UTR123456' });
    const done = await completeCreditRequest(admin, r.id, { paymentMethod: 'UPI', extraCredits: 5 });
    expect(done).toMatchObject({ status: 'COMPLETED', paymentReference: 'UTR123456', balance: 125, bonusCredits: 25 });
    expect(done.invoiceNumber).toMatch(/^CRI-/);
    // Never twice.
    await expect(completeCreditRequest(admin, r.id, { paymentMethod: 'UPI' })).rejects.toThrow(/already added/);
    expect((await creditSummary(ctx)).balance).toBe(125);
    const hist = await listCreditEntries(ctx, { page: 1, pageSize: 10 });
    expect(hist.rows.map((e) => [e.type, e.credits])).toEqual([['BONUS', 25], ['PURCHASE', 100]]);
    expect(hist.rows[0].creditRequest?.code).toBe(r.code);
  });

  it('clients can cancel open requests; declined requests add nothing', async () => {
    const { ctx } = await client();
    const a = await createCreditRequest(ctx, { credits: 200 });
    await cancelCreditRequest(ctx, a.id);
    const b = await createCreditRequest(ctx, { credits: 200 });
    await rejectCreditRequest(admin, b.id, 'Duplicate request');
    await expect(completeCreditRequest(admin, b.id, { paymentMethod: 'UPI' })).rejects.toThrow(/closed/);
    expect((await creditSummary(ctx)).balance).toBe(0);
    // Another workspace can't touch it.
    const other = await client();
    await expect(cancelCreditRequest(other.ctx, a.id)).rejects.toThrow(/not found/i);
  });

  it('platform adjustments add or remove credits with a reason, never below zero', async () => {
    const { org, ctx } = await client();
    await adjustCredits(admin, { organizationId: org.id, credits: 50, reason: 'Goodwill' });
    await expect(adjustCredits(admin, { organizationId: org.id, credits: -60, reason: 'Too much' })).rejects.toThrow(/only 50/);
    await adjustCredits(admin, { organizationId: org.id, credits: -20, reason: 'Correction' });
    expect((await creditSummary(ctx)).balance).toBe(30);
    const ov = await creditOverview();
    expect(ov.wallets.find((w) => w.organizationId === org.id)).toMatchObject({ balance: 30, lifetimeIn: 50 });
  });

  it('expires lots at their expiry date and spends the soonest-expiring credits first', async () => {
    const { org, ctx } = await client();
    await adjustCredits(admin, { organizationId: org.id, credits: 40, reason: 'Short-lived', expiryDays: 1 });
    await adjustCredits(admin, { organizationId: org.id, credits: 100, reason: 'Long-lived', expiryDays: null });
    expect((await creditSummary(ctx)).expiringSoon).toBe(40);
    await withPlatform((tx) => tx.creditEntry.updateMany({ where: { organizationId: org.id, note: 'Short-lived' }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    expect((await creditSummary(ctx)).balance).toBe(100);
    expect((await listCreditEntries(ctx, { type: 'EXPIRY', page: 1, pageSize: 5 })).rows[0]).toMatchObject({ credits: -40 });
  });
});

describe('buying leads with credits', () => {
  it('holds credits at request, delivers instantly and charges no tax', async () => {
    const { org, ctx } = await client();
    await adjustCredits(admin, { organizationId: org.id, credits: 100, reason: 'Top up' });
    const ids = await makeLeads(5);
    const q = await quoteRequest(ctx, { mode: 'ids', ids });
    // 5 × 10 = 50 pre-tax → −10% = 45 credits.
    expect(q.credits).toMatchObject({ cost: 45, balance: 100, enough: true });
    const r = await createLeadRequest(ctx, { selection: { mode: 'ids', ids }, acceptCharges: true, paymentMethod: 'CREDITS' });
    expect(r).toMatchObject({ status: 'FULFILLED', paymentMethod: 'CREDITS', creditsCharged: 45, billingStatus: 'PAID' });
    expect((await creditSummary(ctx)).balance).toBe(55);
  });

  it('refuses when the balance is too low and leaves the leads available', async () => {
    const { org, ctx } = await client();
    await adjustCredits(admin, { organizationId: org.id, credits: 10, reason: 'Top up' });
    const ids = await makeLeads(3);
    await expect(createLeadRequest(ctx, { selection: { mode: 'ids', ids }, acceptCharges: true, paymentMethod: 'CREDITS' })).rejects.toThrow(/Not enough credits/);
    const leads = await withPlatform((tx) => tx.lead.findMany({ where: { id: { in: ids } }, select: { allocationStatus: true } }));
    expect(leads.every((l) => l.allocationStatus === 'UNALLOCATED')).toBe(true);
    expect((await creditSummary(ctx)).balance).toBe(10);
  });

  it('refunds rejected and cancelled requests, and leads that could not be delivered', async () => {
    await saveCreditSettings(admin, { ...settings, autoDeliver: false });
    try {
      const { org, ctx } = await client();
      await adjustCredits(admin, { organizationId: org.id, credits: 200, reason: 'Top up' });
      const a = await createLeadRequest(ctx, { selection: { mode: 'ids', ids: await makeLeads(2) }, acceptCharges: true, paymentMethod: 'CREDITS' });
      expect(a).toMatchObject({ status: 'PENDING', creditsCharged: 18 });
      expect((await creditSummary(ctx)).balance).toBe(182);
      await rejectLeadRequest(admin, a.id, 'Not today');
      expect((await creditSummary(ctx)).balance).toBe(200);

      const b = await createLeadRequest(ctx, { selection: { mode: 'ids', ids: await makeLeads(2) }, acceptCharges: true, paymentMethod: 'CREDITS' });
      await cancelLeadRequest(ctx, b.id);
      expect((await creditSummary(ctx)).balance).toBe(200);

      // One of three leads is taken elsewhere before approval: only the delivered two are charged.
      const ids = await makeLeads(3);
      const c = await createLeadRequest(ctx, { selection: { mode: 'ids', ids }, acceptCharges: true, paymentMethod: 'CREDITS' });
      expect(c.creditsCharged).toBe(27);
      await withPlatform((tx) => tx.lead.update({ where: { id: ids[0] }, data: { archivedAt: new Date() } }));
      const done = await fulfillLeadRequest(admin, c.id);
      expect(done).toMatchObject({ deliveredCount: 2, creditsCharged: 18, billingStatus: 'PAID' });
      expect((await creditSummary(ctx)).balance).toBe(182);
      const types = (await listCreditEntries(ctx, { page: 1, pageSize: 20 })).rows.map((e) => e.type);
      expect(types.filter((t) => t === 'REFUND')).toHaveLength(3);
    } finally {
      await saveCreditSettings(admin, settings);
    }
  });

  it('can require credits for paid leads', async () => {
    await saveCreditSettings(admin, { ...settings, allowInvoice: false });
    try {
      const { ctx } = await client();
      await expect(createLeadRequest(ctx, { selection: { mode: 'ids', ids: await makeLeads(1) }, acceptCharges: true })).rejects.toThrow(/bought with credits/);
    } finally {
      await saveCreditSettings(admin, settings);
    }
  });
});
