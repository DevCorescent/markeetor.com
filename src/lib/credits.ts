import { z } from 'zod';

/**
 * Lead credits — prepaid balance clients buy from the platform team and spend on marketplace leads.
 * Shared by the server (charging, settlement) and the UI (admin rules editor, client purchase screens).
 */

export const creditPackageSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).default(''),
  credits: z.number().int().min(1).max(10_000_000),
  bonusCredits: z.number().int().min(0).max(10_000_000).default(0),
  /** Price in the marketplace currency (before tax). */
  price: z.number().min(0).max(10_000_000),
  popular: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type CreditPackage = z.infer<typeof creditPackageSchema>;

export const creditSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** What clients call them, e.g. "Credits" or "Lead credits". */
  label: z.string().trim().min(1).max(30).default('Credits'),
  /** Spending: how many credits a lead costs. `price` = its marketplace price ÷ creditValue; `fixed` = a flat number per paid lead. */
  costMode: z.enum(['price', 'fixed']).default('price'),
  /** Currency value of one credit when spending (price mode). */
  creditValue: z.number().min(0.01).max(100_000).default(1),
  fixedCreditsPerLead: z.number().int().min(1).max(1_000_000).default(10),
  /** Extra discount for paying with credits (an incentive to prepay). */
  spendDiscountPct: z.number().min(0).max(90).default(0),
  /** Buying: ready-made packs. */
  packages: z.array(creditPackageSchema).max(20).default([
    { id: 'starter', name: 'Starter', description: 'Try the marketplace', credits: 500, bonusCredits: 0, price: 500, popular: false, enabled: true },
    { id: 'growth', name: 'Growth', description: 'For steady prospecting', credits: 2000, bonusCredits: 200, price: 2000, popular: true, enabled: true },
    { id: 'scale', name: 'Scale', description: 'Best value for teams', credits: 5000, bonusCredits: 750, price: 5000, popular: false, enabled: true },
  ]),
  /** Buying: any amount, priced per credit, with bonus tiers. */
  custom: z.object({
    enabled: z.boolean().default(true),
    minCredits: z.number().int().min(1).max(10_000_000).default(100),
    maxCredits: z.number().int().min(1).max(10_000_000).default(100_000),
    pricePerCredit: z.number().min(0.0001).max(100_000).default(1),
  }).default({ enabled: true, minCredits: 100, maxCredits: 100_000, pricePerCredit: 1 }),
  bonusTiers: z.array(z.object({ minCredits: z.number().int().min(1), bonusPct: z.number().min(0).max(200) })).max(10).default([{ minCredits: 5000, bonusPct: 10 }, { minCredits: 20000, bonusPct: 20 }]),
  /** Tax added to credit purchases (spending credits is tax-free). */
  taxPct: z.number().min(0).max(100).default(0),
  /** Purchased credits expire this many days after they are added (null = never). */
  expiryDays: z.number().int().min(1).max(3650).nullable().default(null),
  /** Credits every new wallet starts with. */
  welcomeCredits: z.number().int().min(0).max(1_000_000).default(0),
  /** Notify a workspace when its balance drops below this. 0 = off. */
  lowBalanceThreshold: z.number().int().min(0).max(10_000_000).default(100),
  /** Requests paid with credits are delivered instantly. */
  autoDeliver: z.boolean().default(true),
  /** Clients may still choose an invoice for paid requests; off = paid leads need credits. */
  allowInvoice: z.boolean().default(true),
  /** Shown to clients when they request credits (bank transfer / UPI details, payment link…). */
  paymentInstructions: z.string().trim().max(2000).default(''),
  /** Payment methods the platform team records against a purchase. */
  paymentMethods: z.array(z.string().trim().min(1).max(40)).max(12).default(['Bank transfer', 'UPI', 'Card', 'Cheque', 'Cash']),
  /** Per-client rules. */
  overrides: z.array(z.object({
    organizationId: z.string().min(1),
    spendDiscountPct: z.number().min(0).max(90).nullable().default(null),
    bonusPct: z.number().min(0).max(200).default(0),
  })).max(500).default([]),
});
export type CreditSettings = z.infer<typeof creditSettingsSchema>;
export const DEFAULT_CREDIT_SETTINGS: CreditSettings = creditSettingsSchema.parse({});

const ceilCredits = (x: number) => Math.max(0, Math.ceil(x - 1e-9));

/**
 * Credits needed to pay a quote. Price mode converts the pre-tax amount (after free leads, volume,
 * account and coupon discounts); fixed mode charges per paid lead. The credit discount applies last.
 */
export function creditCost(q: { totalCents: number; taxCents: number; paidCount: number }, s: CreditSettings, orgId?: string | null) {
  if (q.paidCount <= 0 || q.totalCents <= 0) return 0;
  const o = orgId ? s.overrides.find((x) => x.organizationId === orgId) : null;
  const discount = (o?.spendDiscountPct ?? s.spendDiscountPct) / 100;
  const raw = s.costMode === 'fixed' ? q.paidCount * s.fixedCreditsPerLead : (q.totalCents - q.taxCents) / (s.creditValue * 100);
  return ceilCredits(raw * (1 - discount));
}

export type CreditPurchase = { packageId: string | null; packageName: string | null; credits: number; bonusCredits: number; amountCents: number; taxCents: number; totalCents: number; bonusPct: number };

/** Prices a credit purchase — a package, or a custom amount with bonus tiers — plus any client bonus. */
export function priceCreditPurchase(input: { packageId?: string | null; credits?: number | null }, s: CreditSettings, orgId?: string | null): CreditPurchase | { error: string } {
  const clientBonus = orgId ? (s.overrides.find((x) => x.organizationId === orgId)?.bonusPct ?? 0) : 0;
  let base: { packageId: string | null; packageName: string | null; credits: number; bonus: number; amountCents: number; bonusPct: number };
  if (input.packageId) {
    const pkg = s.packages.find((x) => x.id === input.packageId && x.enabled);
    if (!pkg) return { error: 'That credit pack is not available' };
    base = { packageId: pkg.id, packageName: pkg.name, credits: pkg.credits, bonus: pkg.bonusCredits, amountCents: Math.round(pkg.price * 100), bonusPct: 0 };
  } else {
    const n = Math.floor(input.credits ?? 0);
    if (!s.custom.enabled) return { error: 'Custom amounts are not available — choose a credit pack' };
    if (n < s.custom.minCredits || n > s.custom.maxCredits) return { error: `Choose between ${s.custom.minCredits.toLocaleString()} and ${s.custom.maxCredits.toLocaleString()} credits` };
    const tier = [...s.bonusTiers].sort((a, b) => b.minCredits - a.minCredits).find((t) => n >= t.minCredits);
    const bonusPct = tier?.bonusPct ?? 0;
    base = { packageId: null, packageName: null, credits: n, bonus: Math.floor((n * bonusPct) / 100), amountCents: Math.round(n * s.custom.pricePerCredit * 100), bonusPct };
  }
  const extra = Math.floor((base.credits * clientBonus) / 100);
  const taxCents = Math.round((base.amountCents * s.taxPct) / 100);
  return {
    packageId: base.packageId, packageName: base.packageName, credits: base.credits, bonusCredits: base.bonus + extra,
    amountCents: base.amountCents, taxCents, totalCents: base.amountCents + taxCents, bonusPct: base.bonusPct + clientBonus,
  };
}

export const fmtCredits = (n: number) => n.toLocaleString('en-US');

export const CREDIT_ENTRY_LABEL: Record<string, string> = {
  PURCHASE: 'Purchase', BONUS: 'Bonus', WELCOME: 'Welcome credits', GRANT: 'Added by platform', SPEND: 'Leads purchased',
  REFUND: 'Refund', ADJUSTMENT: 'Removed by platform', EXPIRY: 'Expired',
};
export const CREDIT_REQUEST_LABEL: Record<string, string> = {
  PENDING: 'Requested', AWAITING_PAYMENT: 'Awaiting payment', COMPLETED: 'Credits added', REJECTED: 'Declined', CANCELLED: 'Cancelled',
};
