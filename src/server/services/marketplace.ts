import { Prisma, type LeadRequest } from '@prisma/client';
import { z } from 'zod';
import { filterSchema, type Condition, type Filter } from '@/lib/filters';
import { buildQuote, couponLabel, DEFAULT_PRICING, describeDynamic, describeRule, priceLead, pricingSchema, type LeadInfo, type PriceStep, type Pricing } from '@/lib/pricing';
import { isFreeEmail } from '@/lib/onboarding';
import { researchOf } from '@/lib/research-score';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { shortCode } from '../crypto';
import { withPlatform, type Tx } from '../db';
import { AppError, notFound } from '../errors';
import { logger } from '../logger';
import { getSetting, invalidateSetting } from '../settings';
import { recordRedemption, releaseRedemption, resolveCoupon, toQuoteCoupon } from './coupons';
import { getCreditSettings, refundCredits, spendCredits, walletBalance } from './credits';
import { checkSpending } from './workspace-automation';
import { creditCost } from '@/lib/credits';
import { createDistribution, executeBatch } from './distribution';
import { cleanCompanyName, looksLikeBusiness } from '@/lib/business';
import { companyLinks } from '@/lib/company-registry';
import { buildLeadWhere } from './lead-filters';
import { notifyPermission, notifyUsers } from './notifications';

/**
 * Lead marketplace. Clients browse the platform's available leads with every identifying detail hidden,
 * request them individually or in bulk, and receive them through the normal distribution engine once
 * approved. Requests are priced by the platform's pricing rules; each workspace gets a free demo allowance.
 */

// ── Pricing settings ───────────────────────────────────────────────

export async function getPricing(): Promise<Pricing> {
  const raw = await getSetting('pricing');
  const parsed = pricingSchema.safeParse({ ...DEFAULT_PRICING, ...(raw as object) });
  return parsed.success ? parsed.data : DEFAULT_PRICING;
}

export async function savePricing(ctx: AuthContext, input: Pricing) {
  const value = pricingSchema.parse(input);
  const before = await getPricing();
  await withPlatform(async (tx) => {
    await tx.platformSetting.upsert({ where: { key: 'pricing' }, create: { key: 'pricing', value: value as unknown as Prisma.InputJsonValue, updatedById: ctx.user.id }, update: { value: value as unknown as Prisma.InputJsonValue, updatedById: ctx.user.id } });
    await audit(tx, ctx, { action: 'settings.pricing.updated', targetType: 'platform_setting', targetId: 'pricing', organizationId: null, before, after: value });
  });
  invalidateSetting('pricing');
  return value;
}

/**
 * How unsaved pricing would change real prices: re-prices a sample of the available catalog under the
 * current and the proposed settings, with how many leads carry each kind of information.
 */
export async function pricingImpact(proposed: Pricing) {
  const current = await getPricing();
  const next = pricingSchema.parse(proposed);
  const rows = await withPlatform((tx) => tx.lead.findMany({ where: AVAILABLE, select: CATALOG_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 2000 }));
  const stats = (xs: number[]) => xs.length ? { avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), min: Math.min(...xs), max: Math.max(...xs), total: xs.reduce((a, b) => a + b, 0) } : { avg: 0, min: 0, max: 0, total: 0 };
  const coverage: Record<string, number> = {};
  const now: number[] = [], then: number[] = [];
  const examples: { ref: string; industry: string | null; ageDays: number; transfers: number; current: number; proposed: number; steps: PriceStep[] }[] = [];
  for (const r of rows) {
    const info = leadInfo(r);
    for (const [k, v] of Object.entries(info)) if (v === true) coverage[k] = (coverage[k] ?? 0) + 1;
    if (info.researchConfidence != null) coverage.researched = (coverage.researched ?? 0) + 1;
    const a = priceLead({ ...r, info }, current), b = priceLead({ ...r, info }, next);
    now.push(a.cents); then.push(b.cents);
    if (examples.length < 6) examples.push({ ref: ref(r.id), industry: r.industry, ageDays: Math.floor((Date.now() - r.createdAt.getTime()) / 86400_000), transfers: r.distributionCount, current: a.cents, proposed: b.cents, steps: b.steps });
  }
  // A spread of examples: newest, plus the cheapest and dearest under the proposal.
  const order = then.map((c, i) => ({ c, i })).sort((x, y) => x.c - y.c);
  for (const pick of [order[0], order.at(-1)]) {
    if (!pick || pick.i < 6) continue;
    const r = rows[pick.i], info = leadInfo(r);
    examples.push({ ref: ref(r.id), industry: r.industry, ageDays: Math.floor((Date.now() - r.createdAt.getTime()) / 86400_000), transfers: r.distributionCount, current: now[pick.i], proposed: then[pick.i], steps: priceLead({ ...r, info }, next).steps });
  }
  return { sampled: rows.length, currency: next.currency, current: stats(now), proposed: stats(then), coverage, examples };
}

// ── Catalog (masked) ───────────────────────────────────────────────

/** Only these attributes are ever filterable or visible to clients — no names, companies or contact data. */
const CLIENT_FILTER_FIELDS = new Set(['country', 'state', 'industry', 'source', 'campaign', 'score', 'priority', 'createdAt', 'distributionCount', 'seniority', 'hasEmail', 'hasPhone', 'states', 'cities', 'keyword', 'enrichment']);

/** Seniority is derived from the (hidden) job title; clients can filter by it without ever seeing titles. */
export const SENIORITY_KEYWORDS: Record<string, string[]> = {
  Executive: ['chief', 'ceo', 'cfo', 'cto', 'coo', 'founder', 'owner', 'president', 'partner'],
  Director: ['vp', 'vice president', 'director', 'head'],
  Manager: ['manager', 'lead'],
};

/** Filters on derived attributes (seniority, has email/phone) that the generic lead filter does not know. */
function virtualWhere(f: Filter): Prisma.LeadWhereInput[] {
  const out: Prisma.LeadWhereInput[] = [];
  for (const c of f.conditions) {
    if (c.field === 'states' || c.field === 'cities') {
      const vals = (Array.isArray(c.value) ? c.value : [c.value]).map(String).filter(Boolean);
      const col = c.field === 'states' ? 'state' : 'city';
      if (vals.length && c.op === 'not_in') out.push({ NOT: { OR: vals.map((v) => ({ [col]: { equals: v, mode: 'insensitive' as const } })) } });
      else if (vals.length) out.push({ OR: vals.map((v) => ({ [col]: { equals: v, mode: 'insensitive' as const } })) });
    }
    if (c.field === 'hasEmail') out.push(c.op === 'false' ? { emailNormalized: null } : { NOT: { emailNormalized: null } });
    if (c.field === 'hasPhone') out.push(c.op === 'false' ? { phoneNormalized: null } : { NOT: { phoneNormalized: null } });
    if (c.field === 'seniority') {
      const levels = (Array.isArray(c.value) ? c.value : [c.value]).map(String).filter((v) => v in SENIORITY_KEYWORDS || v === 'Professional');
      if (!levels.length) continue;
      const any = (kws: string[]) => kws.map((k) => ({ jobTitle: { contains: k, mode: 'insensitive' as const } }));
      const ors: Prisma.LeadWhereInput[] = levels.filter((l) => l !== 'Professional').flatMap((l) => any(SENIORITY_KEYWORDS[l]));
      if (levels.includes('Professional')) ors.push({ AND: [{ NOT: { jobTitle: null } }, { NOT: { OR: Object.values(SENIORITY_KEYWORDS).flatMap(any) } }] });
      out.push({ OR: ors });
    }
  }
  return out;
}
const CATALOG_SELECT = { id: true, country: true, state: true, industry: true, source: true, campaign: true, score: true, priority: true, createdAt: true, distributionCount: true, emailNormalized: true, phoneNormalized: true, jobTitle: true, company: true, fullName: true, city: true, enrichment: { select: { status: true, confidence: true, data: true, checks: true, domain: true, finishedAt: true } } } satisfies Prisma.LeadSelect;

/** Leads that may be offered: active, valid, not allocated, not reserved by another request or batch. */
const AVAILABLE: Prisma.LeadWhereInput = { allocationStatus: 'UNALLOCATED', archivedAt: null, mergedIntoId: null, quality: 'VALID' };

/** Strips anything but whitelisted conditions (and free-text search, which could probe names) from a client filter. */
export { virtualWhere, AVAILABLE as MARKET_AVAILABLE };

/** Available leads matching a client marketplace filter (unsafe conditions are dropped). */
export function marketWhere(filter: Filter): Prisma.LeadWhereInput {
  return { AND: [AVAILABLE, buildLeadWhere(safeFilter(filter), 'active'), ...virtualWhere(filter)] };
}

export function safeFilter(f: Filter): Filter {
  return { conditions: f.conditions.filter((c) => CLIENT_FILTER_FIELDS.has(c.field)) };
}

const ref = (id: string) => `LD-${id.replace(/-/g, '').slice(-6).toUpperCase()}`;
const seniority = (t: string | null) => {
  const s = (t ?? '').toLowerCase();
  if (!s) return null;
  if (/(chief|ceo|cfo|cto|coo|founder|owner|president|partner)/.test(s)) return 'Executive';
  if (/(vp|vice president|director|head)/.test(s)) return 'Director';
  if (/(manager|lead)/.test(s)) return 'Manager';
  return 'Professional';
};

type CatalogRow = Prisma.LeadGetPayload<{ select: typeof CATALOG_SELECT }>;
export { CATALOG_SELECT as PRICE_SELECT };

/**
 * What a lead carries, for information-based pricing — from the lead itself and its research
 * (only facts research is reasonably sure of count).
 */
export function leadInfo(r: Pick<CatalogRow, 'emailNormalized' | 'phoneNormalized' | 'jobTitle' | 'company' | 'fullName' | 'industry' | 'state' | 'city' | 'enrichment'>): LeadInfo {
  const e = r.enrichment && (r.enrichment.status === 'DONE' || r.enrichment.status === 'PARTIAL') ? r.enrichment : null;
  const d = ((e?.data ?? {}) as Record<string, EnrichedField>);
  const has = (k: string, min = 60) => Boolean(d[k] && d[k]!.confidence >= min && d[k]!.value != null && d[k]!.value !== '' && !(Array.isArray(d[k]!.value) && !(d[k]!.value as unknown[]).length));
  const checks = (e?.checks ?? {}) as { email?: { free?: boolean; mx?: boolean | null; disposable?: boolean } | null; phone?: { valid?: boolean; type?: string | null } | null; crawl?: { status?: string } | null };
  const email = r.emailNormalized;
  const level = seniority(r.jobTitle);
  const reg = has('registry', 80) ? (d.registry!.value as { regId?: string | null } | null) : null;
  return {
    email: Boolean(email),
    businessEmail: Boolean(email) && (checks.email ? !checks.email.free && !checks.email.disposable && checks.email.mx !== false : !isFreeEmail(email!)),
    phone: Boolean(r.phoneNormalized),
    mobile: Boolean(r.phoneNormalized && checks.phone?.valid && checks.phone.type === 'MOBILE'),
    jobTitle: Boolean(r.jobTitle?.trim()),
    decisionMaker: level === 'Executive' || level === 'Director',
    location: Boolean(r.city?.trim() || r.state?.trim()),
    company: Boolean(r.company?.trim() || has('companyName') || looksLikeBusiness(r.fullName)),
    industry: Boolean(r.industry?.trim() || has('industry')),
    website: checks.crawl?.status === 'ok' || has('website', 80),
    companyProfile: has('description'),
    companySize: has('companySize'),
    registered: Boolean(reg?.regId),
    linkedin: has('linkedin', 70),
    researchConfidence: e ? e.confidence : null,
  };
}

/** One lead's price with the full dynamic breakdown. */
export const priceRow = (r: CatalogRow, p: Pricing) => priceLead({ ...r, info: leadInfo(r) }, p);

function present(r: CatalogRow, p: Pricing) {
  const { cents } = priceRow(r, p);
  return {
    id: r.id, ref: ref(r.id), country: r.country, state: r.state, industry: r.industry, source: r.source, campaign: r.campaign,
    score: r.score, priority: r.priority, createdAt: r.createdAt, fresh: r.distributionCount === 0,
    hasEmail: Boolean(r.emailNormalized), hasPhone: Boolean(r.phoneNormalized), seniority: seniority(r.jobTitle),
    // Only the final price is shared; the breakdown stays in the admin's price tester and catalog impact.
    priceCents: cents,
    research: researchOf(r.enrichment),
    company: companyPreview(r, p.companyPreview),
  };
}

type EnrichedField = { value: unknown; confidence: number } | undefined;

const INDIAN_HINT = /\b(pvt|private limited|llp|india|bharat)\b/i;
function looksLikeIndian(r: { company?: string | null; fullName?: string | null; enrichment?: { checks?: unknown } | null }) {
  return INDIAN_HINT.test(`${r.company ?? ''} ${r.fullName ?? ''}`) || (r.enrichment?.checks as { phone?: { country?: string | null; suggestion?: { country?: string } | null } | null } | undefined)?.phone?.country === 'IN';
}

/** Official registration facts safe to show (no directors, addresses or contact details). */
export function registrationOf(reg: unknown) {
  if (!reg || typeof reg !== 'object') return null;
  const r = reg as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === 'string' && r[k] ? (r[k] as string) : null);
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : null);
  return {
    source: s('source') as 'falconebiz' | 'opencorporates' | 'website-cin' | null, regId: s('regId'), legalName: s('legalName'), status: s('status'),
    incorporated: s('incorporated'), yearIncorporated: n('yearIncorporated'), type: s('type'), category: s('category'), listed: typeof r.listed === 'boolean' ? r.listed : null,
    roc: s('roc'), registeredIn: [s('district'), s('state')].filter(Boolean).join(', ') || null, activity: s('activity'), paidUpCapital: n('paidUpCapital'), authorisedCapital: n('authorisedCapital'), url: s('url'),
  };
}

/**
 * Replaces 1–3 word runs that spell the company's domain name, or most of it ("TalentSphere" for
 * talentspheretech.com, "Akshar Eye Clinic" for akshareyeclinic.com).
 */
function redactStem(text: string, stem: string) {
  const parts = text.split(/(\s+)/);
  const words = parts.map((p, i) => ({ p, i })).filter((x) => /\S/.test(x.p));
  const key = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '');
  const kill = new Set<number>();
  for (let a = 0; a < words.length; a++) {
    let joined = '';
    let best = -1;
    for (let b = a; b < Math.min(words.length, a + 4); b++) {
      joined += key(words[b].p);
      if (!joined || !stem.startsWith(joined)) break;
      if (joined === stem || joined.length >= Math.max(6, Math.ceil(stem.length * 0.6))) best = b; // keep extending: longest match wins
    }
    if (best >= 0) { for (let k = a; k <= best; k++) kill.add(words[k].i); a = best; }
  }
  if (!kill.size) return text;
  let first = true;
  return parts.map((p, i) => {
    if (!kill.has(i)) return p;
    const isStart = first || !kill.has(words[words.findIndex((w) => w.i === i) - 1]?.i ?? -1);
    first = false;
    if (!isStart) return '';
    const trail = p.match(/[^a-z0-9]+$/i)?.[0] ?? '';
    return `The company${trail}`;
  }).join('').replace(/\s+/g, ' ');
}

/**
 * The anonymised company profile a client sees before buying: what the business does and how established
 * it is, from AI research — with its name, domain, web address, emails and phone numbers removed so the
 * lead can't be identified (or contacted) without purchasing it. Low-confidence facts are left out.
 */
export function companyPreview(r: Pick<CatalogRow, 'company' | 'enrichment'> & { fullName?: string | null }, cfg: Pricing['companyPreview']) {
  if (!cfg.enabled) return null;
  const e = r.enrichment;
  const researched = Boolean(e && (e.status === 'DONE' || e.status === 'PARTIAL'));
  const d = ((researched ? e!.data : null) ?? {}) as Record<string, EnrichedField>;
  const val = <T,>(k: string, min = 60) => (d[k] && d[k]!.confidence >= min ? (d[k]!.value as T) : null);
  const name = cfg.name ? cleanCompanyName(val<string>('companyName') ?? r.company ?? (looksLikeBusiness(r.fullName) ? r.fullName : null), e?.domain) : null;
  if (!researched || !e) {
    return name ? { name, researched: false, searched: false, confidence: 0, researchedAt: null, industry: null, website: null, linkedin: null, specialty: null, description: null, size: null, founded: null, yearsInBusiness: null, headquarters: null, keywords: [], sellsTo: null, signals: null, registration: null, links: companyLinks(name, { india: looksLikeIndian(r) }) } : null;
  }
  const names = [r.company, val<string>('companyName', 0), e.domain, e.domain?.split('.')[0]]
    .filter((x): x is string => typeof x === 'string' && x.trim().length >= 3)
    .flatMap((x) => [x, x.replace(/\b(private limited|pvt\.? ?ltd|ltd|limited|llc|inc|corp|co)\.?$/i, '').trim()])
    .filter((x) => x.length >= 3);
  const redact = (t: string) => {
    // Sentences carrying a web address, domain, email or phone number are dropped entirely.
    const contact = /https?:\/\/|www\.|\S+@\S+|\b[a-z0-9-]+\.(com|net|org|io|co|in|us|uk|biz|info|test|ca|au)\b|\+?\d[\d\s().-]{6,}\d/i;
    let out = t.split(/(?<=[.!?])\s+/).filter((x) => !contact.test(x)).join(' ');
    if (cfg.name) return out.replace(/\s+/g, ' ').trim(); // the name is shown anyway; only contacts are removed
    for (const n of names) out = out.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'The company');
    // The domain spelled with spaces or punctuation ("akshareyeclinic" → "Akshar Eye Clinic").
    const stem = (e.domain ?? '').split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (stem.length >= 4) out = redactStem(out, stem);
    // The leading words of a known company name ("Peak Roofing" from "Peak Roofing Co.").
    for (const n of names) {
      const words = n.split(/\s+/).filter((w) => w.length > 2);
      if (words.length >= 2) out = out.replace(new RegExp(`\\b${words.slice(0, 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}`, 'gi'), 'The company');
    }
    return out.replace(/(The company\W*){2,}/g, 'The company ').replace(/\s+/g, ' ').trim();
  };
  const hq = val<{ city?: string | null; state?: string | null; country?: string | null }>('headquarters');
  const hqText = !hq || cfg.headquarters === 'none' ? null
    : cfg.headquarters === 'city' ? [hq.city, hq.state, hq.country].filter(Boolean).join(', ')
    : cfg.headquarters === 'region' ? [hq.state, hq.country].filter(Boolean).join(', ') || hq.country || null
    : hq.country ?? null;
  const checks = (e.checks ?? {}) as { email?: { free?: boolean; mx?: boolean | null; disposable?: boolean } | null; phone?: { valid?: boolean; type?: string | null; suggestion?: unknown } | null; crawl?: { status?: string } | null };
  const description = cfg.description ? val<string>('description') : null;
  const keywords = cfg.keywords ? (val<string[]>('keywords', 55) ?? []).map((k) => redact(String(k)).toLowerCase()).filter((k) => k && !k.includes('the company')).slice(0, 6) : [];
  const founded = cfg.founded ? val<number>('foundedYear') : null;
  const profile = {
    name,
    researched: e.status === 'DONE',
    /** Research ran (a PARTIAL result means no public website was found). */
    searched: true,
    confidence: e.confidence,
    researchedAt: e.finishedAt,
    industry: val<string>('industry'),
    // The company's own web presence (never its phone/email, and never the lead's contact details).
    website: name && cfg.website ? (val<string>('website', 80) ?? (e.domain && checks.crawl?.status === 'ok' ? `https://${e.domain}` : null)) : null,
    linkedin: name && cfg.website ? val<string>('linkedin', 70) : null,
    specialty: val<string>('subIndustry') ? redact(String(val<string>('subIndustry'))) : null,
    description: description ? redact(description).slice(0, 320) : null,
    size: cfg.size ? val<string>('companySize') : null,
    founded,
    yearsInBusiness: founded ? new Date().getFullYear() - founded : null,
    headquarters: hqText || null,
    keywords,
    sellsTo: val<boolean>('b2b') == null ? null : val<boolean>('b2b') ? 'Businesses' : 'Consumers',
    registration: registrationOf(val('registry', 80)),
    links: name ? companyLinks(name, { cin: (val<{ regId?: string | null }>('registry', 80))?.regId ?? null, india: looksLikeIndian(r) || (val<{ jurisdiction?: string | null }>('registry', 80))?.jurisdiction === 'in' }) : [],
    signals: cfg.signals ? {
      businessEmail: checks.email ? Boolean(!checks.email.free && !checks.email.disposable && checks.email.mx !== false) : null,
      website: checks.crawl?.status === 'ok' ? true : e.domain ? false : null,
      linkedin: Boolean(val<string>('linkedin')),
      phoneType: checks.phone?.valid || checks.phone?.suggestion ? (checks.phone?.type ?? 'valid') : checks.phone ? 'unverified' : null,
    } : null,
  };
  const hasContent = profile.name || profile.description || profile.size || profile.founded || profile.headquarters || profile.keywords.length || profile.specialty || profile.signals;
  return hasContent ? profile : null;
}

const CATALOG_SORTS: Record<string, (d: boolean) => Prisma.LeadOrderByWithRelationInput> = {
  createdAt: (d) => ({ createdAt: d ? 'desc' : 'asc' }),
  score: (d) => ({ score: d ? 'desc' : 'asc' }),
  country: (d) => ({ country: { sort: d ? 'desc' : 'asc', nulls: 'last' } }),
  industry: (d) => ({ industry: { sort: d ? 'desc' : 'asc', nulls: 'last' } }),
};

function assertMarketplace(ctx: AuthContext, p: Pricing) {
  if (!p.marketplaceEnabled) throw new AppError('FORBIDDEN', 'The lead marketplace is currently closed');
  const features = ((ctx.org?.settings as { features?: Record<string, boolean> } | null)?.features ?? {});
  if (ctx.scope === 'ORGANIZATION' && features.marketplace === false) throw new AppError('FORBIDDEN', 'The lead marketplace is not enabled for this workspace');
}

export async function listCatalog(ctx: AuthContext, params: { filter: Filter; sort?: { id: string; desc: boolean } | null; page: number; pageSize: number; ids?: string[] }) {
  const p = await getPricing();
  assertMarketplace(ctx, p);
  return withPlatform(async (tx) => {
    const where: Prisma.LeadWhereInput = { AND: [marketWhere(params.filter), ...(params.ids ? [{ id: { in: params.ids } }] : [])] };
    const skip = (params.page - 1) * params.pageSize;
    if (params.sort?.id === 'research') {
      // Researched leads by score, then the unresearched ones (a relation sort can't put missing research last).
      const done: Prisma.LeadWhereInput = { enrichment: { status: { in: ['DONE', 'PARTIAL'] } } };
      const researchedWhere = { AND: [where, done] }, restWhere = { AND: [where, { NOT: done }] };
      const [total, researched] = await Promise.all([tx.lead.count({ where }), tx.lead.count({ where: researchedWhere })]);
      const first = skip < researched ? await tx.lead.findMany({ where: researchedWhere, select: CATALOG_SELECT, orderBy: [{ enrichment: { confidence: params.sort.desc ? 'desc' : 'asc' } }, { createdAt: 'desc' }, { id: 'asc' }], skip, take: params.pageSize }) : [];
      const rest = first.length < params.pageSize ? await tx.lead.findMany({ where: restWhere, select: CATALOG_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: Math.max(0, skip - researched), take: params.pageSize - first.length }) : [];
      return { total, rows: [...first, ...rest].map((r) => present(r, p)), currency: p.currency };
    }
    const order = params.sort && Object.hasOwn(CATALOG_SORTS, params.sort.id) ? CATALOG_SORTS[params.sort.id](params.sort.desc) : { createdAt: 'desc' as const };
    const [total, rows] = await Promise.all([
      tx.lead.count({ where }),
      tx.lead.findMany({ where, select: CATALOG_SELECT, orderBy: [order, { id: 'asc' }], skip, take: params.pageSize }),
    ]);
    return { total, rows: rows.map((r) => present(r, p)), currency: p.currency };
  }).then((res) => {
    // Demand analytics: what clients look for (first page of filtered searches only).
    if (params.page === 1 && !params.ids) void import('./insights').then((m) => m.logMarketSearch(ctx, params.filter, res.total));
    return res;
  });
}

/** Filter options and headline numbers for the catalog (aggregates only). */
export async function catalogFacets(ctx: AuthContext) {
  const p = await getPricing();
  assertMarketplace(ctx, p);
  return withPlatform(async (tx) => {
    const facet = async (field: 'country' | 'industry' | 'source' | 'campaign' | 'state') =>
      (await tx.lead.groupBy({ by: [field], where: { ...AVAILABLE, [field]: { not: null } }, _count: true, orderBy: { _count: { [field]: 'desc' } }, take: 100 }))
        .map((r) => ({ value: r[field] as string, count: r._count }));
    const [countries, industries, sources, campaigns, states, total, fresh, week] = await Promise.all([
      facet('country'), facet('industry'), facet('source'), facet('campaign'), facet('state'),
      tx.lead.count({ where: AVAILABLE }),
      tx.lead.count({ where: { ...AVAILABLE, distributionCount: 0 } }),
      tx.lead.count({ where: { ...AVAILABLE, createdAt: { gte: new Date(Date.now() - 7 * 86400_000) } } }),
    ]);
    return { countries, industries, sources, campaigns, states, total, fresh, addedThisWeek: week };
  });
}

// ── Quotes & requests ──────────────────────────────────────────────

export const requestSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ids'), ids: z.array(z.string().max(64)).min(1).max(5000) }),
  z.object({ mode: z.literal('filter'), filter: filterSchema, excludeIds: z.array(z.string().max(64)).max(5000).default([]), limit: z.number().int().min(1).max(5000).optional() }),
]);
export type RequestSelection = z.infer<typeof requestSelectionSchema>;

async function allowance(tx: Tx, orgId: string, p: Pricing) {
  const override = p.overrides.find((o) => o.organizationId === orgId);
  const total = override?.freeLeads ?? p.freeLeadsPerClient;
  const used = await tx.leadRequest.aggregate({ where: { organizationId: orgId, status: { in: ['PENDING', 'FULFILLED', 'PARTIAL'] } }, _sum: { freeApplied: true } });
  const u = used._sum.freeApplied ?? 0;
  return { total, used: u, remaining: Math.max(0, total - u), discountPct: override?.discountPct ?? 0 };
}

async function resolveCandidates(tx: Tx, sel: RequestSelection, max: number) {
  const where: Prisma.LeadWhereInput = sel.mode === 'ids'
    ? { AND: [AVAILABLE, { id: { in: sel.ids } }] }
    : { AND: [AVAILABLE, buildLeadWhere(safeFilter(sel.filter), 'active'), ...virtualWhere(sel.filter), sel.excludeIds.length ? { id: { notIn: sel.excludeIds } } : {}] };
  const requested = sel.mode === 'ids' ? sel.ids.length : Math.min(sel.limit ?? max, max);
  if (sel.mode === 'ids' && sel.ids.length > max) throw new AppError('VALIDATION_FAILED', `Requests are limited to ${max} leads at a time`);
  const rows = await tx.lead.findMany({ where, select: CATALOG_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: Math.min(requested, max) });
  return { rows, requested };
}

function priceRows(rows: CatalogRow[], p: Pricing) {
  return rows.map((r) => ({ leadId: r.id, ...priceRow(r, p) }));
}

export async function quoteRequest(ctx: AuthContext, sel: RequestSelection, couponCode?: string | null) {
  const p = await getPricing();
  assertMarketplace(ctx, p);
  return withPlatform(async (tx) => {
    const { rows, requested } = await resolveCandidates(tx, sel, p.maxPerRequest);
    const a = await allowance(tx, ctx.orgId!, p);
    const priced = priceRows(rows, p);
    let quote = buildQuote(priced, p, { freeRemaining: a.remaining, clientDiscountPct: a.discountPct });
    let coupon: { code: string; name: string; label: string; error: string | null } | null = null;
    if (couponCode?.trim()) {
      const r = await resolveCoupon(tx, couponCode, ctx.orgId!, { leadCount: rows.length, subtotalCents: quote.subtotalCents });
      if (r.coupon) {
        quote = buildQuote(priced, p, { freeRemaining: a.remaining, clientDiscountPct: a.discountPct, coupon: toQuoteCoupon(r.coupon) });
        coupon = { code: r.coupon.code, name: r.coupon.name, label: couponLabel(toQuoteCoupon(r.coupon), p.currency), error: null };
      } else coupon = { code: couponCode.trim().toUpperCase(), name: '', label: '', error: r.error };
    }
    const autoApprove = (quote.totalCents === 0 && p.autoApproveFree) || p.autoApprovePaid;
    const cs = await getCreditSettings();
    const credits = cs.enabled ? (() => {
      const cost = creditCost(quote, cs, ctx.orgId);
      return { enabled: true, label: cs.label, cost, allowInvoice: cs.allowInvoice, autoDeliver: cs.autoDeliver || autoApprove };
    })() : null;
    const balance = credits ? await walletBalance(tx, ctx.orgId!) : 0;
    return { requested, available: rows.length, unavailable: Math.max(0, requested - rows.length), allowance: a, quote: { ...quote, freeLeadIds: undefined }, coupon, autoApprove, maxPerRequest: p.maxPerRequest, credits: credits ? { ...credits, balance, enough: balance >= credits.cost } : null };
  });
}

const createInput = z.object({ selection: requestSelectionSchema, note: z.string().trim().max(500).optional(), acceptCharges: z.boolean().default(false), couponCode: z.string().trim().max(32).optional(), paymentMethod: z.enum(['INVOICE', 'CREDITS']).default('INVOICE') });
export { createInput as leadRequestInput };

export async function createLeadRequest(ctx: AuthContext, input: Omit<z.infer<typeof createInput>, 'paymentMethod'> & { paymentMethod?: 'INVOICE' | 'CREDITS' }) {
  const p = await getPricing();
  assertMarketplace(ctx, p);
  const orgId = ctx.orgId!;
  const cs = await getCreditSettings();
  const method = input.paymentMethod ?? 'INVOICE';
  if (method === 'CREDITS' && !cs.enabled) throw new AppError('FORBIDDEN', 'Credits are not available right now');
  const req = await withPlatform(async (tx) => {
    const { rows } = await resolveCandidates(tx, input.selection, p.maxPerRequest);
    if (!rows.length) throw new AppError('CONFLICT', 'None of these leads are available any more');
    // Reserve atomically: only leads still unallocated are taken; anything grabbed concurrently is left out.
    const reserved = await tx.$queryRaw<{ id: string }[]>`
      UPDATE leads SET "allocationStatus" = 'PENDING', "updatedAt" = now()
      WHERE id = ANY(${rows.map((r) => r.id)}::text[]) AND "allocationStatus" = 'UNALLOCATED' AND "archivedAt" IS NULL AND quality = 'VALID'
      RETURNING id`;
    const got = new Set(reserved.map((r) => r.id));
    const mine = rows.filter((r) => got.has(r.id));
    if (!mine.length) throw new AppError('CONFLICT', 'These leads were just taken. Refresh and try again.');
    const a = await allowance(tx, orgId, p);
    const priced = priceRows(mine, p);
    let quote = buildQuote(priced, p, { freeRemaining: a.remaining, clientDiscountPct: a.discountPct });
    let coupon = null;
    if (input.couponCode?.trim()) {
      const r = await resolveCoupon(tx, input.couponCode, orgId, { leadCount: mine.length, subtotalCents: quote.subtotalCents, lock: true });
      if (!r.coupon) throw new AppError('VALIDATION_FAILED', r.error ?? 'That coupon cannot be used');
      coupon = r.coupon;
      quote = buildQuote(priced, p, { freeRemaining: a.remaining, clientDiscountPct: a.discountPct, coupon: toQuoteCoupon(coupon) });
    }
    if (quote.totalCents > 0 && !input.acceptCharges) throw new AppError('PRECONDITION_FAILED', 'Please confirm the charges for this request', { totalCents: quote.totalCents });
    const useCredits = method === 'CREDITS' && quote.totalCents > 0;
    if (quote.totalCents > 0 && !useCredits && cs.enabled && !cs.allowInvoice) throw new AppError('PRECONDITION_FAILED', `Paid leads are bought with ${cs.label.toLowerCase()}. Choose “Pay with ${cs.label.toLowerCase()}”.`);
    const credits = useCredits ? creditCost(quote, cs, orgId) : 0;
    await checkSpending(tx, ctx, { credits, amountCents: useCredits ? 0 : quote.totalCents });
    let code = shortCode('REQ');
    while (await tx.leadRequest.findUnique({ where: { code } })) code = shortCode('REQ');
    const free = new Set(quote.freeLeadIds);
    const request = await tx.leadRequest.create({
      data: {
        code, organizationId: orgId, requestedById: ctx.user.id, note: input.note ?? null, leadCount: mine.length, freeApplied: quote.freeApplied,
        paymentMethod: useCredits ? 'CREDITS' : 'INVOICE', creditsCharged: credits,
        currency: quote.currency, subtotal: quote.subtotalCents / 100, discount: quote.discountCents / 100, tax: quote.taxCents / 100, total: quote.totalCents / 100,
        couponId: coupon?.id ?? null, couponCode: coupon?.code ?? null, couponDiscount: quote.couponDiscountCents / 100,
        quote: { ...quote, freeLeadIds: undefined } as unknown as Prisma.InputJsonValue,
        items: { create: priced.map((i) => ({ organizationId: orgId, leadId: i.leadId, price: i.cents / 100, free: free.has(i.leadId) })) },
      },
    });
    if (coupon) await recordRedemption(tx, { couponId: coupon.id, organizationId: orgId, requestId: request.id, discount: quote.couponDiscountCents / 100, extraFreeLeads: quote.couponFreeLeads });
    // Credits are held now (all-or-nothing with the reservation) and settled on delivery.
    if (useCredits) await spendCredits(tx, orgId, credits, { leadRequestId: request.id, note: `${code} · ${mine.length - quote.freeApplied} paid lead${mine.length - quote.freeApplied === 1 ? '' : 's'}`, actorId: ctx.user.id });
    await audit(tx, ctx, { action: 'marketplace.request.created', targetType: 'lead_request', targetId: request.id, metadata: { code, leads: mine.length, free: quote.freeApplied, total: quote.totalCents / 100, currency: quote.currency, coupon: coupon?.code, paymentMethod: useCredits ? 'CREDITS' : 'INVOICE', credits } });
    return { request, autoApprove: (quote.totalCents === 0 && p.autoApproveFree) || p.autoApprovePaid || (useCredits && cs.autoDeliver) };
  }, { timeout: 60_000 });

  if (req.autoApprove) {
    try {
      return await fulfillLeadRequest(null, req.request.id, { initiatorId: ctx.user.id, note: 'Approved automatically' });
    } catch (err) {
      logger.error({ err, request: req.request.id }, 'auto-fulfilment failed; left pending for review');
    }
  }
  const order = req.request;
  await import('./endpoints').then((m) => m.emitEmailEvent('order.created', {
    order: { id: order.id, code: order.code, leadCount: order.leadCount, total: Number(order.total), currency: order.currency, paymentMethod: order.paymentMethod },
    organization: { id: orgId, name: ctx.org?.name ?? '', code: ctx.org?.code ?? '' }, requestedBy: { name: ctx.user.name, email: ctx.user.email },
  }, order.id)).catch(() => null);
  await notifyPermission('marketplace.manage', null, { type: 'LEAD_REQUEST', title: `${ctx.org?.name ?? 'A client'} requested ${req.request.leadCount} lead${req.request.leadCount === 1 ? '' : 's'}`, body: `${req.request.code} · ${req.request.paymentMethod === 'CREDITS' ? `${req.request.creditsCharged.toLocaleString()} credits held` : Number(req.request.total) > 0 ? `${req.request.currency} ${Number(req.request.total).toFixed(2)}` : 'free demo leads'}`, link: '/admin/marketplace?tab=requests' });
  return req.request;
}

/** Releases reserved leads of a request back to the pool. */
async function release(tx: Tx, requestId: string) {
  const items = await tx.leadRequestItem.findMany({ where: { requestId, status: 'REQUESTED' }, select: { id: true, leadId: true } });
  if (items.length) {
    await tx.lead.updateMany({ where: { id: { in: items.map((i) => i.leadId) }, allocationStatus: 'PENDING' }, data: { allocationStatus: 'UNALLOCATED' } });
    await tx.leadRequestItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { status: 'RELEASED' } });
  }
  return items.length;
}

/**
 * Approves a request: hands the reserved leads to the distribution engine (same guarantees, audit and
 * history as any batch), then bills only for what was actually delivered.
 */
export async function fulfillLeadRequest(ctx: AuthContext | null, id: string, opts: { initiatorId?: string; note?: string } = {}) {
  const r = await withPlatform((tx) => tx.leadRequest.findUnique({ where: { id }, include: { items: true } }));
  if (!r) throw notFound('Request');
  if (r.status !== 'PENDING') throw new AppError('CONFLICT', `This request is already ${r.status.toLowerCase()}`);
  const p = await getPricing();
  const leadIds = r.items.filter((i) => i.status === 'REQUESTED').map((i) => i.leadId);
  // Hand the reservation over to the distribution engine, which reserves them again inside its own transaction.
  await withPlatform((tx) => tx.lead.updateMany({ where: { id: { in: leadIds }, allocationStatus: 'PENDING' }, data: { allocationStatus: 'UNALLOCATED' } }));
  const initiatorId = ctx?.user.id ?? opts.initiatorId ?? r.requestedById;
  const { batch } = await createDistribution(ctx, {
    selection: { mode: 'ids', ids: leadIds }, strategy: 'EQUAL', targets: [{ organizationId: r.organizationId }],
    respectQuotas: false, includeInvalid: true, avoidPreviousClients: false, idempotencyKey: `lead-request:${r.id}`, confirmLarge: true, note: `Lead request ${r.code}`,
  }, { mode: 'MANUAL', initiatorId });
  await executeBatch(batch.id);

  return withPlatform(async (tx) => {
    const assigned = await tx.assignmentBatchItem.findMany({ where: { batchId: batch.id, status: 'ASSIGNED' }, select: { leadId: true } });
    const delivered = new Set(assigned.map((a) => a.leadId));
    await tx.leadRequestItem.updateMany({ where: { requestId: id, leadId: { in: [...delivered] } }, data: { status: 'DELIVERED' } });
    await tx.leadRequestItem.updateMany({ where: { requestId: id, status: 'REQUESTED' }, data: { status: 'UNAVAILABLE' } });
    // Leads the engine could not deliver go back to the pool.
    await tx.lead.updateMany({ where: { id: { in: leadIds.filter((l) => !delivered.has(l)) }, allocationStatus: 'PENDING' }, data: { allocationStatus: 'UNALLOCATED' } });

    // Re-bill on what was delivered (free leads stay free; tiers/discount recomputed on the delivered paid count).
    const items = r.items.filter((i) => delivered.has(i.leadId));
    const paid = items.filter((i) => !i.free);
    const override = p.overrides.find((o) => o.organizationId === r.organizationId);
    // Percentage / fixed coupons are re-applied to what was delivered; free-lead coupons are already in the free items.
    const coupon = r.couponId ? await tx.coupon.findUnique({ where: { id: r.couponId } }) : null;
    const qc = coupon && coupon.type !== 'FREE_LEADS' ? toQuoteCoupon(coupon) : null;
    const q = buildQuote(paid.map((i) => ({ leadId: i.leadId, cents: Math.round(Number(i.price) * 100), applied: [] })), { ...p, currency: r.currency }, { freeRemaining: 0, clientDiscountPct: override?.discountPct ?? 0, coupon: qc });
    if (r.couponId) {
      if (delivered.size === 0) await releaseRedemption(tx, id);
      else await tx.couponRedemption.updateMany({ where: { requestId: id }, data: { discount: q.couponDiscountCents / 100 } });
    }
    const freeApplied = items.length - paid.length;
    // Credits: charge only for what was delivered, return the rest.
    const byCredits = r.paymentMethod === 'CREDITS';
    let creditsCharged = r.creditsCharged;
    if (byCredits) {
      const cs = await getCreditSettings();
      creditsCharged = Math.min(r.creditsCharged, creditCost(q, cs, r.organizationId));
      await refundCredits(tx, r.organizationId, r.creditsCharged - creditsCharged, { leadRequestId: id, note: `${r.code} · ${r.leadCount - delivered.size} lead${r.leadCount - delivered.size === 1 ? '' : 's'} not delivered`, actorId: ctx?.user.id ?? null });
    }
    let invoiceNumber: string | null = null;
    if (q.totalCents > 0) {
      invoiceNumber = shortCode('INV', 8);
      while (await tx.leadRequest.findUnique({ where: { invoiceNumber } })) invoiceNumber = shortCode('INV', 8);
    }
    const original = r.quote as { lines?: unknown[] };
    const updated = await tx.leadRequest.update({
      where: { id },
      data: {
        status: delivered.size === 0 ? 'REJECTED' : delivered.size < r.leadCount ? 'PARTIAL' : 'FULFILLED',
        deliveredCount: delivered.size, freeApplied, subtotal: q.subtotalCents / 100, discount: q.discountCents / 100, tax: q.taxCents / 100, total: q.totalCents / 100, couponDiscount: q.couponDiscountCents / 100,
        billingStatus: q.totalCents > 0 ? (byCredits ? 'PAID' : 'DUE') : 'NONE', paidAt: byCredits && q.totalCents > 0 ? new Date() : null, creditsCharged, invoiceNumber, batchId: batch.id, decidedById: ctx?.user.id ?? null, decidedAt: new Date(),
        adminNote: delivered.size === 0 ? 'None of the leads could be delivered' : (opts.note ?? r.adminNote),
        quote: { ...(original as object), delivered: delivered.size, final: { ...q, freeLeadIds: undefined } } as unknown as Prisma.InputJsonValue,
      },
    });
    if (ctx) await audit(tx, ctx, { action: 'marketplace.request.fulfilled', targetType: 'lead_request', targetId: id, organizationId: r.organizationId, metadata: { code: r.code, delivered: delivered.size, total: q.totalCents / 100 } });
    await notifyUsers([r.requestedById], {
      type: 'LEAD_REQUEST_FULFILLED', organizationId: r.organizationId,
      title: delivered.size ? `${delivered.size} requested lead${delivered.size === 1 ? ' is' : 's are'} now in your workspace` : `Request ${r.code} could not be delivered`,
      body: delivered.size ? `${r.code}${q.totalCents > 0 ? (byCredits ? ` · paid with ${creditsCharged.toLocaleString()} credits` : ` · invoice ${invoiceNumber} for ${r.currency} ${(q.totalCents / 100).toFixed(2)}`) : ' · free demo leads'}` : `The leads were taken before approval. You were not charged${byCredits ? ' and your credits were returned' : ''}.`,
      link: delivered.size ? '/app/leads?view=unassigned' : '/app/marketplace?tab=requests',
    }, tx);
    return updated;
  }, { timeout: 60_000 }).then(async (updated) => {
    if (updated.billingStatus === 'DUE' || updated.billingStatus === 'PAID') {
      const { issueInvoice } = await import('./finance');
      await issueInvoice('LEAD_PURCHASE', updated.id);
    }
    const [org, by] = await withPlatform((tx) => Promise.all([
      tx.organization.findUnique({ where: { id: updated.organizationId }, select: { id: true, name: true, code: true, contactEmail: true } }),
      tx.user.findUnique({ where: { id: updated.requestedById }, select: { name: true, email: true } }),
    ]));
    await import('./endpoints').then((m) => m.emitEmailEvent('order.fulfilled', {
      order: { id: updated.id, code: updated.code, leadCount: updated.leadCount, deliveredCount: updated.deliveredCount, total: Number(updated.total), currency: updated.currency },
      organization: org, requestedBy: by,
    }, updated.id)).catch(() => null);
    // A first paid purchase completes a referral.
    if (Number(updated.total) > 0) {
      const { rewardReferral } = await import('./client-tools');
      await rewardReferral(updated.organizationId).catch(() => null);
    }
    return updated;
  });
}

export async function rejectLeadRequest(ctx: AuthContext, id: string, reason: string) {
  return withPlatform(async (tx) => {
    const r = await tx.leadRequest.findUnique({ where: { id } });
    if (!r) throw notFound('Request');
    if (r.status !== 'PENDING') throw new AppError('CONFLICT', 'Only pending requests can be rejected');
    await release(tx, id);
    await releaseRedemption(tx, id);
    if (r.paymentMethod === 'CREDITS') await refundCredits(tx, r.organizationId, r.creditsCharged, { leadRequestId: id, note: `${r.code} declined`, actorId: ctx.user.id });
    const updated = await tx.leadRequest.update({ where: { id }, data: { status: 'REJECTED', creditsCharged: 0, billingStatus: 'VOID', adminNote: reason, decidedById: ctx.user.id, decidedAt: new Date() } });
    await audit(tx, ctx, { action: 'marketplace.request.rejected', targetType: 'lead_request', targetId: id, organizationId: r.organizationId, reason });
    await notifyUsers([r.requestedById], { type: 'LEAD_REQUEST_REJECTED', organizationId: r.organizationId, title: `Request ${r.code} was declined`, body: reason, link: '/app/marketplace?tab=requests' }, tx);
    return updated;
  });
}

export async function cancelLeadRequest(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const r = await tx.leadRequest.findUnique({ where: { id } });
    if (!r || r.organizationId !== ctx.orgId) throw notFound('Request');
    if (r.status !== 'PENDING') throw new AppError('CONFLICT', 'Only pending requests can be cancelled');
    await release(tx, id);
    await releaseRedemption(tx, id);
    if (r.paymentMethod === 'CREDITS') await refundCredits(tx, r.organizationId, r.creditsCharged, { leadRequestId: id, note: `${r.code} cancelled`, actorId: ctx.user.id });
    const updated = await tx.leadRequest.update({ where: { id }, data: { status: 'CANCELLED', creditsCharged: 0, billingStatus: 'VOID', decidedAt: new Date() } });
    await audit(tx, ctx, { action: 'marketplace.request.cancelled', targetType: 'lead_request', targetId: id });
    return updated;
  });
}

export async function setBillingStatus(ctx: AuthContext, id: string, status: 'DUE' | 'PAID' | 'WAIVED' | 'VOID', note?: string) {
  return withPlatform(async (tx) => {
    const r = await tx.leadRequest.findUnique({ where: { id } });
    if (!r) throw notFound('Request');
    if (r.billingStatus === 'NONE') throw new AppError('CONFLICT', 'Nothing to bill on this request');
    const updated = await tx.leadRequest.update({ where: { id }, data: { billingStatus: status, paidAt: status === 'PAID' ? new Date() : null, adminNote: note ?? r.adminNote } });
    await audit(tx, ctx, { action: 'marketplace.billing.updated', targetType: 'lead_request', targetId: id, organizationId: r.organizationId, before: { billingStatus: r.billingStatus }, after: { billingStatus: status }, reason: note });
    return updated;
  }).then(async (updated) => {
    const { issueInvoice, markInvoicePaid } = await import('./finance');
    if (status === 'DUE' || status === 'PAID') await issueInvoice('LEAD_PURCHASE', id);
    await markInvoicePaid(id, status === 'PAID');
    return updated;
  });
}

// ── Listings ───────────────────────────────────────────────────────

const serialize = (r: LeadRequest & { organization?: { name: string } | null; requester?: { name: string; email: string } | null }) => ({
  ...r, subtotal: Number(r.subtotal), discount: Number(r.discount), tax: Number(r.tax), total: Number(r.total), couponDiscount: Number(r.couponDiscount),
});

export async function listLeadRequests(ctx: AuthContext, params: { status?: string; billing?: string; organizationId?: string; page: number; pageSize: number }) {
  const platform = ctx.scope === 'PLATFORM';
  const run = async (tx: Tx) => {
    const where: Prisma.LeadRequestWhereInput = {
      ...(platform ? (params.organizationId ? { organizationId: params.organizationId } : {}) : { organizationId: ctx.orgId! }),
      ...(params.status ? { status: params.status as 'PENDING' } : {}),
      ...(params.billing ? { billingStatus: params.billing as 'DUE' } : {}),
    };
    const [total, rows] = await Promise.all([
      tx.leadRequest.count({ where }),
      tx.leadRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
    ]);
    const users = await tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.requestedById))] } }, select: { id: true, name: true, email: true } });
    const orgs = platform ? await tx.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.organizationId))] } }, select: { id: true, name: true } }) : [];
    return {
      total,
      rows: rows.map((r) => serialize({ ...r, requester: users.find((u) => u.id === r.requestedById) ?? null, organization: orgs.find((o) => o.id === r.organizationId) ?? null })),
    };
  };
  // The organization filter above scopes clients to their own requests.
  return withPlatform(run);
}

/** Request detail with masked lead attributes (clients) — identities appear only in "My leads" once delivered. */
export async function getLeadRequest(ctx: AuthContext, id: string) {
  const r = await withPlatform((tx) => tx.leadRequest.findUnique({ where: { id }, include: { items: true } }));
  if (!r || (ctx.scope !== 'PLATFORM' && r.organizationId !== ctx.orgId)) throw notFound('Request');
  const leads = await withPlatform((tx) => tx.lead.findMany({ where: { id: { in: r.items.map((i) => i.leadId) } }, select: { ...CATALOG_SELECT, fullName: ctx.scope === 'PLATFORM' } }));
  const p = await getPricing();
  const byId = new Map(leads.map((l) => [l.id, l]));
  return {
    ...serialize(r),
    items: r.items.map((i) => {
      const l = byId.get(i.leadId);
      return { id: i.id, status: i.status, free: i.free, price: Number(i.price), lead: l ? { ...present(l, p), ...(ctx.scope === 'PLATFORM' ? { fullName: (l as { fullName?: string }).fullName } : {}) } : null };
    }),
  };
}

/** Free allowance, balances and the public price list for a workspace. */
export async function billingSummary(ctx: AuthContext, orgId = ctx.orgId!) {
  const p = await getPricing();
  return withPlatform(async (tx) => {
    const a = await allowance(tx, orgId, p);
    const sums = await tx.leadRequest.groupBy({ by: ['billingStatus'], where: { organizationId: orgId }, _sum: { total: true, deliveredCount: true }, _count: true });
    const sum = (s: string) => Number(sums.find((x) => x.billingStatus === s)?._sum.total ?? 0);
    const delivered = await tx.leadRequest.aggregate({ where: { organizationId: orgId, status: { in: ['FULFILLED', 'PARTIAL'] } }, _sum: { deliveredCount: true } });
    const pending = await tx.leadRequest.count({ where: { organizationId: orgId, status: 'PENDING' } });
    return {
      currency: p.currency,
      allowance: a,
      outstanding: sum('DUE'), paid: sum('PAID'), waived: sum('WAIVED'),
      leadsReceived: delivered._sum.deliveredCount ?? 0, pendingRequests: pending,
      priceList: p.showPriceList || ctx.scope === 'PLATFORM' ? {
        basePrice: p.basePrice, minPrice: p.minPrice, taxPct: p.taxPct, maxPerRequest: p.maxPerRequest,
        clientDiscountPct: a.discountPct,
        rules: [...describeDynamic(p.dynamic), ...p.rules.filter((r) => r.enabled).map((r) => ({ name: r.name, description: describeRule(r, p.currency) }))],
        volumeTiers: p.volumeTiers,
        autoApprove: { free: p.autoApproveFree, paid: p.autoApprovePaid },
      } : null,
    };
  });
}

/** Platform-wide marketplace overview for admins. */
export async function marketplaceOverview() {
  return withPlatform(async (tx) => {
    const [byStatus, byBilling, perOrg, pool] = await Promise.all([
      tx.leadRequest.groupBy({ by: ['status'], _count: true, _sum: { leadCount: true, deliveredCount: true } }),
      tx.leadRequest.groupBy({ by: ['billingStatus'], _count: true, _sum: { total: true } }),
      tx.leadRequest.groupBy({ by: ['organizationId', 'billingStatus'], _sum: { total: true, deliveredCount: true, freeApplied: true }, _count: true }),
      tx.lead.count({ where: AVAILABLE }),
    ]);
    const orgs = await tx.organization.findMany({ where: { id: { in: [...new Set(perOrg.map((r) => r.organizationId))] } }, select: { id: true, name: true } });
    const clients = new Map<string, { id: string; name: string; requests: number; delivered: number; free: number; due: number; paid: number; waived: number }>();
    for (const r of perOrg) {
      const c = clients.get(r.organizationId) ?? { id: r.organizationId, name: orgs.find((o) => o.id === r.organizationId)?.name ?? '—', requests: 0, delivered: 0, free: 0, due: 0, paid: 0, waived: 0 };
      c.requests += r._count;
      c.delivered += r._sum.deliveredCount ?? 0;
      c.free += r._sum.freeApplied ?? 0;
      const t = Number(r._sum.total ?? 0);
      if (r.billingStatus === 'DUE') c.due += t;
      if (r.billingStatus === 'PAID') c.paid += t;
      if (r.billingStatus === 'WAIVED') c.waived += t;
      clients.set(r.organizationId, c);
    }
    return {
      pool,
      status: Object.fromEntries(byStatus.map((s) => [s.status, { count: s._count, leads: s._sum.leadCount ?? 0, delivered: s._sum.deliveredCount ?? 0 }])),
      billing: Object.fromEntries(byBilling.map((b) => [b.billingStatus, { count: b._count, amount: Number(b._sum.total ?? 0) }])),
      clients: [...clients.values()].sort((a, b) => b.due + b.paid - (a.due + a.paid)),
    };
  });
}

export type { Condition };
