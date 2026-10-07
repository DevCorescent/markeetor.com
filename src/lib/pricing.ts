import { z } from 'zod';
import { conditionSchema, type Condition } from './filters';

/**
 * Lead marketplace pricing — shared by the server (authoritative quotes) and the browser (live price
 * previews and the public price list). All money is computed in integer cents.
 */

/** Lead attributes that may be used for pricing and shown in the marketplace (never contact details). */
export const PRICING_FIELDS = ['country', 'state', 'industry', 'source', 'campaign', 'score', 'priority', 'ageDays', 'distributionCount'] as const;

export const pricingRuleSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  conditions: z.array(conditionSchema).max(10).default([]),
  action: z.enum(['SET', 'ADD', 'MULTIPLY']),
  /** SET / ADD: currency amount. MULTIPLY: percentage (150 = ×1.5, 80 = 20% off). */
  amount: z.number().min(-100_000).max(100_000),
});
export type PricingRule = z.infer<typeof pricingRuleSchema>;

/** What a lead carries — each can raise its price. Computed on the server from the lead and its research. */
export const INFO_ATTRIBUTES = [
  { key: 'email', label: 'Email address', group: 'Contact data', pct: 10 },
  { key: 'businessEmail', label: 'Business email', group: 'Contact data', pct: 15 },
  { key: 'phone', label: 'Phone number', group: 'Contact data', pct: 15 },
  { key: 'mobile', label: 'Verified mobile', group: 'Contact data', pct: 10 },
  { key: 'jobTitle', label: 'Job title', group: 'Person', pct: 5 },
  { key: 'decisionMaker', label: 'Decision-maker', group: 'Person', pct: 20 },
  { key: 'location', label: 'City or state', group: 'Person', pct: 5 },
  { key: 'company', label: 'Company name', group: 'Company', pct: 5 },
  { key: 'industry', label: 'Industry', group: 'Company', pct: 5 },
  { key: 'website', label: 'Live company website', group: 'Company', pct: 10 },
  { key: 'companyProfile', label: 'Company description', group: 'Company', pct: 5 },
  { key: 'companySize', label: 'Company size', group: 'Company', pct: 5 },
  { key: 'registered', label: 'Registered (CIN / LLPIN)', group: 'Company', pct: 10 },
  { key: 'linkedin', label: 'Company LinkedIn page', group: 'Company', pct: 5 },
] as const;
export type InfoKey = (typeof INFO_ATTRIBUTES)[number]['key'];
const INFO_KEYS = INFO_ATTRIBUTES.map((a) => a.key) as [InfoKey, ...InfoKey[]];

export const dynamicPricingSchema = z.object({
  enabled: z.boolean().default(true),
  /** % added to the standard price for each kind of information a lead has (negative to discount). */
  attributes: z.array(z.object({ key: z.enum(INFO_KEYS), enabled: z.boolean().default(true), pct: z.number().min(-90).max(500) })).max(30)
    .default(INFO_ATTRIBUTES.map((a) => ({ key: a.key, enabled: true, pct: a.pct }))),
  /** Up to `maxPct` more for well-researched leads, scaled by research confidence (only above `minConfidence`). */
  research: z.object({ enabled: z.boolean().default(true), maxPct: z.number().min(0).max(300).default(20), minConfidence: z.number().int().min(0).max(100).default(40) })
    .default({ enabled: true, maxPct: 20, minConfidence: 40 }),
  /** Older leads lose `pct`% every `everyDays` after `graceDays`, never below `floorPct`% of their price. */
  age: z.object({ enabled: z.boolean().default(true), graceDays: z.number().int().min(0).max(3650).default(7), everyDays: z.number().int().min(1).max(365).default(30), pct: z.number().min(0).max(90).default(10), floorPct: z.number().min(0).max(100).default(40) })
    .default({ enabled: true, graceDays: 7, everyDays: 30, pct: 10, floorPct: 40 }),
  /** Each previous sale/transfer of the lead takes off `pct`%, never below `floorPct`% of its price. */
  transfers: z.object({ enabled: z.boolean().default(true), pct: z.number().min(0).max(90).default(15), floorPct: z.number().min(0).max(100).default(30) })
    .default({ enabled: true, pct: 15, floorPct: 30 }),
  /** Optional ceiling per lead (currency units). */
  maxPrice: z.number().min(0).max(100_000).nullable().default(null),
  /** Show clients how each lead's price was worked out. */
  showBreakdown: z.boolean().default(true),
});
export type DynamicPricing = z.infer<typeof dynamicPricingSchema>;
export const defaultDynamicPricing = (): DynamicPricing => dynamicPricingSchema.parse({});

export const pricingSchema = z.object({
  marketplaceEnabled: z.boolean(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  basePrice: z.number().min(0).max(100_000),
  minPrice: z.number().min(0).max(100_000),
  freeLeadsPerClient: z.number().int().min(0).max(100_000),
  autoApproveFree: z.boolean(),
  autoApprovePaid: z.boolean(),
  taxPct: z.number().min(0).max(100),
  maxPerRequest: z.number().int().min(1).max(5000),
  showPriceList: z.boolean(),
  autoAnnounce: z.boolean(),
  volumeTiers: z.array(z.object({ minQty: z.number().int().min(2).max(100_000), discountPct: z.number().min(0).max(90) })).max(10),
  rules: z.array(pricingRuleSchema).max(50),
  overrides: z.array(z.object({ organizationId: z.string().min(1).max(64), discountPct: z.number().min(0).max(100).optional(), freeLeads: z.number().int().min(0).max(100_000).optional() })).max(500),
  /** What clients see about a lead's company before buying (from AI research; never names, websites or contacts). */
  companyPreview: z.object({
    enabled: z.boolean().default(true),
    /** The company's name (never its website, contacts or people). */
    name: z.boolean().default(true),
    description: z.boolean().default(true),
    size: z.boolean().default(true),
    founded: z.boolean().default(true),
    headquarters: z.enum(['none', 'country', 'region', 'city']).default('region'),
    keywords: z.boolean().default(true),
    signals: z.boolean().default(true),
    /** The company's own website and LinkedIn page (company info, not the lead's contact details). */
    website: z.boolean().default(true),
  }).default({ enabled: true, name: true, description: true, size: true, founded: true, headquarters: 'region', keywords: true, signals: true, website: true }),
  dynamic: dynamicPricingSchema.default(defaultDynamicPricing),
});
export type CompanyPreviewSettings = Pricing['companyPreview'];
export type Pricing = z.infer<typeof pricingSchema>;

export const DEFAULT_PRICING: Pricing = {
  marketplaceEnabled: true,
  currency: 'USD',
  basePrice: 5,
  minPrice: 0,
  freeLeadsPerClient: 10,
  autoApproveFree: true,
  autoApprovePaid: false,
  taxPct: 0,
  maxPerRequest: 500,
  showPriceList: true,
  autoAnnounce: true,
  volumeTiers: [{ minQty: 50, discountPct: 10 }, { minQty: 200, discountPct: 20 }],
  rules: [
    { id: 'hot', name: 'High-intent leads (score 80+)', enabled: true, conditions: [{ field: 'score', op: 'gte', value: 80 }], action: 'MULTIPLY', amount: 150 },
  ],
  overrides: [],
  companyPreview: { enabled: true, name: true, description: true, size: true, founded: true, headquarters: 'region', keywords: true, signals: true, website: true },
  dynamic: dynamicPricingSchema.parse({}),
};

export type LeadInfo = Partial<Record<InfoKey, boolean>> & { researchConfidence?: number | null };
export type PricedLead = { country: string | null; state: string | null; industry: string | null; source: string | null; campaign: string | null; score: number; priority: string; createdAt: string | Date; distributionCount: number; info?: LeadInfo };
export type PriceStep = { kind: 'base' | 'info' | 'research' | 'rule' | 'age' | 'transfers' | 'limit'; label: string; deltaCents: number; detail?: string };

const lc = (v: unknown) => String(v ?? '').trim().toLowerCase();
const list = (v: Condition['value']) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => lc(x)).filter(Boolean);

function fieldValue(lead: PricedLead, field: string, now: number): string | number | null {
  switch (field) {
    case 'ageDays': return Math.floor((now - new Date(lead.createdAt).getTime()) / 86400_000);
    case 'score': return lead.score;
    case 'distributionCount': return lead.distributionCount;
    case 'country': case 'state': case 'industry': case 'source': case 'campaign': case 'priority': return lead[field];
    default: return null;
  }
}

export function conditionMatches(lead: PricedLead, c: Condition, now = Date.now()): boolean {
  const v = fieldValue(lead, c.field, now);
  if (typeof v === 'number' || c.op === 'gte' || c.op === 'lte') {
    const n = Number(v), t = Number(Array.isArray(c.value) ? c.value[0] : c.value);
    if (!Number.isFinite(n) || !Number.isFinite(t)) return false;
    return c.op === 'gte' ? n >= t : c.op === 'lte' ? n <= t : n === t;
  }
  const s = lc(v);
  switch (c.op) {
    case 'in': case 'eq': return list(c.value).includes(s);
    case 'not_in': case 'neq': return !list(c.value).includes(s);
    case 'contains': return list(c.value).some((x) => s.includes(x));
    case 'empty': return !s;
    case 'not_empty': return Boolean(s);
    default: return false;
  }
}

/**
 * Price of one lead in cents, with every step that shaped it:
 *   standard price → + information the lead carries → + research quality → custom rules
 *   → − age depreciation (floored) → − resale depreciation (floored) → min/max limits.
 */
export function priceLead(lead: PricedLead, p: Pick<Pricing, 'basePrice' | 'minPrice' | 'rules'> & { dynamic?: DynamicPricing }, now = Date.now()) {
  const base = Math.round(p.basePrice * 100);
  let cents = base;
  const applied: string[] = [];
  const steps: PriceStep[] = [{ kind: 'base', label: 'Standard price', deltaCents: base }];
  const d = p.dynamic;
  const push = (kind: PriceStep['kind'], label: string, next: number, detail?: string) => {
    const delta = next - cents;
    cents = next;
    if (delta !== 0) steps.push({ kind, label, deltaCents: delta, detail });
  };

  if (d?.enabled && lead.info) {
    // Information value: every enabled attribute the lead has adds its % of the standard price.
    for (const a of d.attributes) {
      if (!a.enabled || !a.pct || !lead.info[a.key]) continue;
      const meta = INFO_ATTRIBUTES.find((x) => x.key === a.key);
      push('info', meta?.label ?? a.key, cents + Math.round((base * a.pct) / 100), `${a.pct > 0 ? '+' : ''}${a.pct}%`);
    }
    // Research quality: scaled by confidence.
    const conf = lead.info.researchConfidence;
    if (d.research.enabled && conf != null && conf >= d.research.minConfidence && d.research.maxPct > 0) {
      const pct = Math.round((d.research.maxPct * conf) / 100 * 10) / 10;
      push('research', 'Researched & verified', Math.round(cents * (1 + pct / 100)), `+${pct}% · ${conf}% confidence`);
    }
  }

  for (const r of p.rules) {
    if (!r.enabled || !r.conditions.every((c) => conditionMatches(lead, c, now))) continue;
    const next = r.action === 'SET' ? Math.round(r.amount * 100) : r.action === 'ADD' ? cents + Math.round(r.amount * 100) : Math.round((cents * r.amount) / 100);
    push('rule', r.name, next);
    applied.push(r.name);
  }

  if (d?.enabled) {
    const ageDays = Math.max(0, Math.floor((now - new Date(lead.createdAt).getTime()) / 86400_000));
    if (d.age.enabled && d.age.pct > 0 && ageDays > d.age.graceDays) {
      const periods = Math.ceil((ageDays - d.age.graceDays) / d.age.everyDays);
      const factor = Math.max(d.age.floorPct / 100, (1 - d.age.pct / 100) ** periods);
      push('age', `Lead age (${ageDays} days)`, Math.round(cents * factor), factor === d.age.floorPct / 100 ? `floor ${d.age.floorPct}% reached` : `−${Math.round((1 - factor) * 100)}%`);
    }
    if (d.transfers.enabled && d.transfers.pct > 0 && lead.distributionCount > 0) {
      const factor = Math.max(d.transfers.floorPct / 100, (1 - d.transfers.pct / 100) ** lead.distributionCount);
      push('transfers', `Sold before (${lead.distributionCount}×)`, Math.round(cents * factor), factor === d.transfers.floorPct / 100 ? `floor ${d.transfers.floorPct}% reached` : `−${Math.round((1 - factor) * 100)}%`);
    }
  }

  const min = Math.round(p.minPrice * 100);
  const max = d?.enabled && d.maxPrice != null ? Math.round(d.maxPrice * 100) : null;
  if (cents < min) push('limit', 'Minimum price', min);
  if (max != null && cents > max) push('limit', 'Maximum price', max);
  cents = Math.max(0, cents);
  if (d?.enabled && steps.some((x) => x.kind === 'info')) applied.unshift('Information value');
  if (steps.some((x) => x.kind === 'research')) applied.push('Research quality');
  if (steps.some((x) => x.kind === 'age')) applied.push('Age');
  if (steps.some((x) => x.kind === 'transfers')) applied.push('Resale');
  return { cents, applied, steps };
}

export type QuoteLine = { label: string; qty: number; unitCents: number; free: boolean };
export type Quote = {
  currency: string; count: number; freeApplied: number; paidCount: number;
  subtotalCents: number; discountCents: number; discountPct: number; tierPct: number; clientPct: number; taxCents: number; totalCents: number;
  lines: QuoteLine[]; freeLeadIds: string[];
  couponCode: string | null; couponDiscountCents: number; couponFreeLeads: number;
};

/** A coupon as applied to a quote. PERCENT/FIXED values are % / currency units; FREE_LEADS is a count. */
export type QuoteCoupon = { code: string; type: 'PERCENT' | 'FIXED' | 'FREE_LEADS'; value: number; maxDiscount?: number | null };

/**
 * Builds a quote. Free demo leads are applied to the most expensive leads first (best value for the client);
 * volume tier and client discounts apply to the paid subtotal, then tax.
 */
export function buildQuote(items: { leadId: string; cents: number; applied: string[] }[], p: Pick<Pricing, 'currency' | 'volumeTiers' | 'taxPct'>, opts: { freeRemaining: number; clientDiscountPct?: number; coupon?: QuoteCoupon | null }): Quote {
  const sorted = [...items].sort((a, b) => b.cents - a.cents || a.leadId.localeCompare(b.leadId));
  const c = opts.coupon ?? null;
  const allowanceFree = Math.max(0, Math.min(opts.freeRemaining, sorted.length));
  const couponFree = c?.type === 'FREE_LEADS' ? Math.max(0, Math.min(Math.floor(c.value), sorted.length - allowanceFree)) : 0;
  const freeN = allowanceFree + couponFree;
  const free = sorted.slice(0, freeN);
  const paid = sorted.slice(freeN);
  const subtotal = paid.reduce((a, i) => a + i.cents, 0);
  const tier = [...p.volumeTiers].sort((a, b) => b.minQty - a.minQty).find((t) => paid.length >= t.minQty);
  const tierPct = tier?.discountPct ?? 0;
  const clientPct = opts.clientDiscountPct ?? 0;
  const discountPct = Math.min(100, tierPct + clientPct);
  const discount = Math.round((subtotal * discountPct) / 100);
  // Coupons apply after volume/account discounts, before tax.
  const afterDiscount = subtotal - discount;
  let couponCents = 0;
  if (c?.type === 'PERCENT') couponCents = Math.round((afterDiscount * Math.min(100, c.value)) / 100);
  if (c?.type === 'FIXED') couponCents = Math.round(c.value * 100);
  if (c?.maxDiscount != null && c.type !== 'FREE_LEADS') couponCents = Math.min(couponCents, Math.round(c.maxDiscount * 100));
  couponCents = Math.max(0, Math.min(couponCents, afterDiscount));
  const tax = Math.round(((afterDiscount - couponCents) * p.taxPct) / 100);
  const group = (rows: typeof items, isFree: boolean) => {
    const m = new Map<string, QuoteLine>();
    for (const r of rows) {
      // Clients see the price only — never how it was worked out.
      const label = 'Marketplace lead';
      const k = String(r.cents);
      const line = m.get(k) ?? { label, qty: 0, unitCents: r.cents, free: isFree };
      line.qty++;
      m.set(k, line);
    }
    return [...m.values()].sort((a, b) => b.unitCents - a.unitCents);
  };
  return {
    currency: p.currency, count: items.length, freeApplied: freeN, paidCount: paid.length,
    subtotalCents: subtotal, discountCents: discount, discountPct, tierPct, clientPct, taxCents: tax, totalCents: afterDiscount - couponCents + tax,
    lines: [...group(free, true), ...group(paid, false)], freeLeadIds: free.map((f) => f.leadId),
    couponCode: c?.code ?? null, couponDiscountCents: couponCents, couponFreeLeads: couponFree,
  };
}

/** Short label for a coupon's effect ("20% off", "$50 off", "5 free leads"). */
export function couponLabel(c: { type: string; value: number; maxDiscount?: number | null }, currency = 'USD') {
  if (c.type === 'PERCENT') return `${c.value}% off${c.maxDiscount ? ` (up to ${money(c.maxDiscount * 100, currency)})` : ''}`;
  if (c.type === 'FIXED') return `${money(c.value * 100, currency)} off`;
  return `${c.value} free lead${c.value === 1 ? '' : 's'}`;
}

export const money = (cents: number, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

/** Plain-English description of a pricing rule for the client-facing price list. */
export function describeRule(r: PricingRule, currency: string) {
  const cond = r.conditions.map((c) => {
    const f = { ageDays: 'age (days)', distributionCount: 'times distributed' }[c.field] ?? c.field;
    const v = Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '');
    return `${f} ${{ gte: '≥', lte: '≤', eq: '=', in: 'is', not_in: 'is not', contains: 'contains', neq: 'is not' }[c.op] ?? c.op} ${v}`;
  }).join(' and ');
  const eff = r.action === 'SET' ? `costs ${money(r.amount * 100, currency)}` : r.action === 'ADD' ? `${r.amount >= 0 ? '+' : '−'}${money(Math.abs(r.amount) * 100, currency)}` : r.amount >= 100 ? `×${(r.amount / 100).toFixed(2).replace(/\.?0+$/, '')}` : `${100 - r.amount}% off`;
  return `${cond ? `When ${cond}: ` : ''}${eff}`;
}

/** Plain-language summary of dynamic pricing for clients' price list and the Lead Finder assistant. */
export function describeDynamic(d: DynamicPricing): { name: string; description: string }[] {
  if (!d.enabled) return [];
  const out: { name: string; description: string }[] = [];
  const on = d.attributes.filter((a) => a.enabled && a.pct !== 0);
  if (on.length) {
    const top = [...on].sort((a, b) => b.pct - a.pct).slice(0, 4).map((a) => INFO_ATTRIBUTES.find((x) => x.key === a.key)?.label.toLowerCase() ?? a.key);
    out.push({ name: 'Information value', description: `Leads with more verified information cost more — e.g. ${top.join(', ')} (up to +${on.filter((a) => a.pct > 0).reduce((s, a) => s + a.pct, 0)}%).` });
  }
  if (d.research.enabled && d.research.maxPct > 0) out.push({ name: 'Research quality', description: `Researched company profiles add up to +${d.research.maxPct}%, scaled by research confidence.` });
  if (d.age.enabled && d.age.pct > 0) out.push({ name: 'Older leads cost less', description: `−${d.age.pct}% every ${d.age.everyDays} days after the first ${d.age.graceDays}, down to ${d.age.floorPct}% of the price.` });
  if (d.transfers.enabled && d.transfers.pct > 0) out.push({ name: 'Previously sold leads cost less', description: `−${d.transfers.pct}% for each previous sale, down to ${d.transfers.floorPct}% of the price.` });
  return out;
}
