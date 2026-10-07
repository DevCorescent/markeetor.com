import Anthropic from '@anthropic-ai/sdk';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Condition, Filter } from '@/lib/filters';
import { buildQuote, couponLabel, describeDynamic, describeRule, money } from '@/lib/pricing';
import { aiStatus } from '../ai';
import { closest, criteriaSchema, emptyCriteria, findValues, isConceptPhrase, sanitize, SLOTS, understand, type Criteria, type Slot, type Vocab } from './finder-nlu';
import type { AuthContext } from '../auth/context';
import { withPlatform, type Tx } from '../db';
import { logger } from '../logger';
import { availableCoupons } from './coupons';
import { buildLeadWhere } from './lead-filters';
import { billingSummary, getPricing, listCatalog, MARKET_AVAILABLE, PRICE_SELECT, priceRow, safeFilter, virtualWhere } from './marketplace';

/**
 * Lead finder: a conversational assistant on the client dashboard that turns "what kind of leads do you need?"
 * into precise marketplace filters. It asks focused questions (one at a time, with live counts), searches,
 * and relaxes filters when nothing matches. A built-in engine always works offline; when AI is enabled the
 * conversation is driven by Claude, which only ever sees aggregate, non-identifying catalog statistics.
 */

export { criteriaSchema, emptyCriteria, understand, sanitize };
export type { Criteria };

export const finderInput = z.object({
  message: z.string().trim().max(1000).nullable().default(null),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('choose'), slot: z.enum(SLOTS), values: z.array(z.string().max(120)).max(25) }),
    z.object({ type: z.literal('skip'), slot: z.enum(SLOTS) }),
    z.object({ type: z.literal('search') }),
    z.object({ type: z.literal('reset') }),
    z.object({ type: z.literal('faq'), id: z.string().max(40) }),
    z.object({ type: z.literal('relax'), criteria: criteriaSchema }),
    z.object({ type: z.literal('start') }),
  ]).nullable().default(null),
  criteria: criteriaSchema.default(emptyCriteria),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2000) })).max(24).default([]),
});
export type FinderInput = z.infer<typeof finderInput>;

type QuickReply = { label: string; action: NonNullable<FinderInput['action']> } | { label: string; message: string };

// ── Criteria → filter ──────────────────────────────────────────────

export function criteriaToFilter(c: Criteria): Filter {
  const cs: Condition[] = [];
  if (c.industries.length) cs.push({ field: 'industry', op: 'in', value: c.industries });
  if (c.keywords.length) cs.push({ field: 'keyword', op: 'in', value: c.keywords });
  if (c.countries.length) cs.push({ field: 'country', op: 'in', value: c.countries });
  if (c.states.length) cs.push({ field: 'states', op: 'in', value: c.states });
  if (c.cities?.length) cs.push({ field: 'cities', op: 'in', value: c.cities });
  if (c.excludeIndustries?.length) cs.push({ field: 'industry', op: 'not_in', value: c.excludeIndustries });
  if (c.excludeCountries?.length) cs.push({ field: 'country', op: 'not_in', value: c.excludeCountries });
  if (c.excludeStates?.length) cs.push({ field: 'states', op: 'not_in', value: c.excludeStates });
  if (c.excludeCities?.length) cs.push({ field: 'cities', op: 'not_in', value: c.excludeCities });
  if (c.sources.length) cs.push({ field: 'source', op: 'in', value: c.sources });
  if (c.campaigns.length) cs.push({ field: 'campaign', op: 'in', value: c.campaigns });
  if (c.priorities.length) cs.push({ field: 'priority', op: 'in', value: c.priorities });
  if (c.seniority.length) cs.push({ field: 'seniority', op: 'in', value: c.seniority });
  if (c.minScore != null) cs.push({ field: 'score', op: 'gte', value: c.minScore });
  if (c.maxScore != null) cs.push({ field: 'score', op: 'lte', value: c.maxScore });
  if (c.freshOnly) cs.push({ field: 'distributionCount', op: 'eq', value: 0 });
  if (c.addedWithinDays) cs.push({ field: 'createdAt', op: 'last_days', value: c.addedWithinDays });
  if (c.needEmail) cs.push({ field: 'hasEmail', op: 'true' });
  if (c.needPhone) cs.push({ field: 'hasPhone', op: 'true' });
  return { conditions: cs };
}

const whereFor = (c: Criteria): Prisma.LeadWhereInput => {
  const f = criteriaToFilter(c);
  return { AND: [MARKET_AVAILABLE, buildLeadWhere(safeFilter(f), 'active'), ...virtualWhere(f)] };
};

// ── Vocabulary (live catalog values) ───────────────────────────────

async function vocabulary(tx: Tx, where: Prisma.LeadWhereInput = MARKET_AVAILABLE): Promise<Vocab> {
  // Generous caps: anything outside the vocabulary is dropped from searches, so it must cover the catalog.
  const g = async (field: 'industry' | 'country' | 'state' | 'city' | 'source' | 'campaign', take = 500) =>
    (await tx.lead.groupBy({ by: [field], where: { AND: [where, { [field]: { not: null } }] }, _count: true, orderBy: { _count: { [field]: 'desc' } }, take }))
      .map((r) => ({ value: r[field] as string, count: r._count }));
  const [industries, countries, states, cities, sources, campaigns, scored, titled] = await Promise.all([
    g('industry'), g('country'), g('state', 500), g('city', 1000), g('source'), g('campaign'),
    tx.lead.count({ where: { AND: [where, { score: { gt: 0 } }] }, take: 1 } as never),
    tx.lead.count({ where: { AND: [where, { NOT: { jobTitle: null } }] }, take: 1 } as never),
  ]);
  return { industries, countries, states, cities, sources, campaigns, caps: { scored: Number(scored) > 0, titled: Number(titled) > 0 } };
}

// ── Keywords (niches beyond the industry list) ─────────────────────

const KW_STOP = new Set(('ceo ceos cfo cto coo founder founders director directors manager managers owner owners head heads md vp vps proprietor proprietors partner partners exec execs cxo '
  + 'mobile mobiles whatsapp calling call calls numbers verified only instead what about how rather switch change remove drop clear any anywhere '
  + 'filter filters requirement requirements condition conditions setting settings fine okay ok please thanks thank '
  + 'a an the and or of to in on at for from with without by near around who whom that which are is be been have has had i me my we us our you your please '
  + 'show find get give need want looking look search any all some only just more less than over under above below best top good great cheap new fresh recent recently '
  + 'lead leads prospect prospects customer customers client clients contact contacts people person companies company business businesses firm firms owners owner '
  + 'phone phones number numbers email emails mail decision decisions makers maker executives executive managers manager directors director senior hot warm cold '
  + 'score scores quality verified exclusive never offered added week weeks month months day days today yesterday last state states country countries city cities region regions '
  + 'located based local usa us uk india budget dollars usd per each about like also really free trial demo how what when where why can could would should will do does did').split(' '));

/**
 * Finds business terms in a message that the structured parser didn't use (e.g. "roofing", "dental clinic")
 * and keeps those that actually match available leads — by industry or by what enrichment learned.
 */
async function keywordPass(message: string | null, c: Criteria, v: Vocab): Promise<{ criteria: Criteria; added: string[]; missing: { term: string; closest: string[] }[] }> {
  if (!message || c.keywords.length >= 3) return { criteria: c, added: [], missing: [] };
  let text = ` ${message.toLowerCase().replace(/[^a-z0-9&\s-]/g, ' ')} `;
  for (const val of [...v.industries, ...v.countries, ...v.states, ...v.cities, ...v.sources, ...v.campaigns].map((x) => x.value.toLowerCase())) if (val.length > 2) text = text.split(` ${val} `).join(' ');
  for (const used of [...c.industries, ...c.countries, ...c.states, ...c.cities, ...c.excludeIndustries, ...c.excludeStates, ...c.excludeCities].map((x) => x.toLowerCase())) text = text.split(used).join(' ');
  // Exclusion clauses never become search keywords.
  text = text.replace(/\b(?:not|no|except|excluding|exclude|without|other than|apart from|outside)\s+(?:in\s+|from\s+)?\S+(?:\s+\S+)?/g, ' ');
  const words = text.split(/\s+/).filter(Boolean);
  const cands: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const a = words[i], b = words[i + 1];
    if (b && !KW_STOP.has(a) && !KW_STOP.has(b) && a.length > 2 && b.length > 2) cands.push(`${a} ${b}`);
  }
  for (const w of words) if (!KW_STOP.has(w) && w.length > 3 && !/^\d+$/.test(w)) cands.push(w.replace(/s$/, ''));
  // Words the industry match already explained ("manufacturers" → Manufacturing) are not extra keywords.
  for (let i = cands.length - 1; i >= 0; i--) if (isConceptPhrase(cands[i]) || (c.industries.length && cands[i].split(' ').some(isConceptPhrase))) cands.splice(i, 1);
  const added: string[] = [];
  const missing: { term: string; closest: string[] }[] = [];
  const next = { ...c, keywords: [...c.keywords] };
  await withPlatform(async (tx) => {
    for (const k of [...new Set(cands)].slice(0, 8)) {
      if (added.length + c.keywords.length >= 3 || added.some((x) => x.includes(k))) continue;
      // Counted together with what is already chosen, so a keyword never empties a good search.
      const n = await tx.lead.count({ where: { AND: [whereFor(next), { OR: [{ industry: { contains: k, mode: 'insensitive' } }, { enrichment: { searchText: { contains: k } } }] }] } });
      if (n > 0) { added.push(k); next.keywords.push(k); }
      else if (!k.includes(' ') && k.length >= 4 && !c.industries.length) missing.push({ term: k, closest: closest(k, v.industries) });
    }
  });
  if (added.length) next.settled = [...new Set([...next.settled, 'industry'])];
  return { criteria: next, added, missing: added.length ? [] : missing.filter((m) => m.closest.length).slice(0, 1) };
}

/** One sentence about what was excluded/removed and niches we don't have (with the closest alternatives). */
function noteFor(intent: { excluded: string[]; removed: string[] }, missing: { term: string; closest: string[] }[]) {
  const parts: string[] = [];
  if (missing.length) parts.push(`I don’t have “${missing[0].term}” leads right now — closest: ${missing[0].closest.join(', ')}.`);
  if (intent.removed.length && !intent.removed.includes('all')) parts.push(`Removed the ${intent.removed.join(', ')} filter${intent.removed.length > 1 ? 's' : ''}.`);
  return parts.join(' ');
}

// ── Search, breakdown and relaxation ───────────────────────────────

async function count(tx: Tx, c: Criteria) {
  return tx.lead.count({ where: whereFor(c) });
}

const CRITERIA_LABELS: [keyof Criteria, (c: Criteria) => string | null][] = [
  ['industries', (c) => (c.industries.length ? c.industries.join(' / ') : null)],
  ['keywords', (c) => (c.keywords.length ? c.keywords.join(' + ') : null)],
  ['countries', (c) => (c.countries.length ? c.countries.join(' / ') : null)],
  ['states', (c) => (c.states.length ? c.states.join(' / ') : null)],
  ['cities', (c) => (c.cities?.length ? c.cities.join(' / ') : null)],
  ['excludeIndustries', (c) => (c.excludeIndustries?.length ? `not ${c.excludeIndustries.join(' / ')}` : null)],
  ['excludeCountries', (c) => (c.excludeCountries?.length ? `not in ${c.excludeCountries.join(' / ')}` : null)],
  ['excludeStates', (c) => (c.excludeStates?.length ? `not in ${c.excludeStates.join(' / ')}` : null)],
  ['excludeCities', (c) => (c.excludeCities?.length ? `not in ${c.excludeCities.join(' / ')}` : null)],
  ['sources', (c) => (c.sources.length ? `from ${c.sources.join(' / ')}` : null)],
  ['campaigns', (c) => (c.campaigns.length ? `campaign ${c.campaigns.join(' / ')}` : null)],
  ['seniority', (c) => (c.seniority.length ? c.seniority.join(' / ') : null)],
  ['priorities', (c) => (c.priorities.length ? `${c.priorities.join('/').toLowerCase()} priority` : null)],
  ['minScore', (c) => (c.minScore != null ? `score ≥ ${c.minScore}` : null)],
  ['maxScore', (c) => (c.maxScore != null ? `score ≤ ${c.maxScore}` : null)],
  ['freshOnly', (c) => (c.freshOnly ? 'never offered before' : null)],
  ['addedWithinDays', (c) => (c.addedWithinDays ? `added in the last ${c.addedWithinDays === 1 ? '24 hours' : `${c.addedWithinDays} days`}` : null)],
  ['needEmail', (c) => (c.needEmail ? 'has email' : null)],
  ['needPhone', (c) => (c.needPhone ? 'has phone' : null)],
];
export const describeCriteria = (c: Criteria) => CRITERIA_LABELS.map(([, f]) => f(c)).filter(Boolean) as string[];

function without(c: Criteria, k: keyof Criteria): Criteria {
  const d = emptyCriteria();
  return { ...c, [k]: d[k] };
}

async function relaxations(tx: Tx, c: Criteria) {
  const out: { label: string; count: number; criteria: Criteria }[] = [];
  for (const [k, f] of CRITERIA_LABELS) {
    const label = f(c);
    if (!label) continue;
    const r = without(c, k);
    const n = await count(tx, r);
    if (n > 0) out.push({ label: `Drop “${label}”`, count: n, criteria: r });
  }
  if (c.minScore != null && c.minScore > 50) {
    const r = { ...c, minScore: Math.max(0, c.minScore - 20) };
    const n = await count(tx, r);
    if (n > 0) out.push({ label: `Score ≥ ${r.minScore} instead`, count: n, criteria: r });
  }
  // Nothing works by dropping one thing: loosen soft constraints first, then location, keeping the industry
  // (the core of what was asked) until last — so the suggestion stays as close to the request as possible.
  if (!out.length) {
    const ORDER: (keyof Criteria)[] = ['minScore', 'maxScore', 'freshOnly', 'addedWithinDays', 'priorities', 'seniority', 'needEmail', 'needPhone', 'campaigns', 'sources', 'excludeCities', 'excludeStates', 'cities', 'states', 'countries', 'keywords', 'industries'];
    let cur = c;
    const dropped: string[] = [];
    for (const k of ORDER) {
      const label = CRITERIA_LABELS.find(([key]) => key === k)?.[1](cur);
      if (!label) continue;
      cur = without(cur, k);
      dropped.push(label);
      const n = await count(tx, cur);
      if (n > 0) { out.push({ label: `Drop ${dropped.map((d) => `“${d}”`).join(' + ')}`, count: n, criteria: cur }); break; }
    }
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 3);
}

async function results(ctx: AuthContext, c: Criteria) {
  const p = await getPricing();
  const filter = criteriaToFilter(c);
  const take = Math.min(c.quantity ?? 50, p.maxPerRequest);
  return withPlatform(async (tx) => {
    const where = whereFor(c);
    const total = await tx.lead.count({ where });
    const g = async (field: 'industry' | 'country') => (await tx.lead.groupBy({ by: [field], where: { AND: [where, { [field]: { not: null } }] }, _count: true, orderBy: { _count: { [field]: 'desc' } }, take: 5 })).map((r) => ({ label: r[field] as string, count: r._count }));
    const [industries, countries, scoreAgg, top] = await Promise.all([
      g('industry'), g('country'),
      tx.lead.aggregate({ where, _avg: { score: true } }),
      tx.lead.findMany({ where, orderBy: [{ score: 'desc' }, { createdAt: 'desc' }], take, select: PRICE_SELECT }),
    ]);
    const priced = top.map((l) => ({ leadId: l.id, ...priceRow(l, p) }));
    const cents = priced.map((x) => x.cents);
    return {
      priced,
      total,
      requestable: top.length,
      filter,
      breakdown: { industries, countries },
      avgScore: Math.round(scoreAgg._avg.score ?? 0),
      priceRange: cents.length ? { min: Math.min(...cents), max: Math.max(...cents) } : null,
      relax: total === 0 ? await relaxations(tx, c) : [],
    };
  }, { timeout: 30_000 }).then(async ({ priced, ...r }) => {
    const summary = await billingSummary(ctx);
    const quote = buildQuote(priced, p, { freeRemaining: summary.allowance.remaining, clientDiscountPct: summary.allowance.discountPct });
    return {
      ...r,
      estimate: { count: priced.length, totalCents: quote.totalCents, freeApplied: quote.freeApplied, currency: p.currency },
      withinBudget: c.budget != null ? quote.totalCents <= c.budget * 100 : null,
      sample: r.total ? (await listCatalog(ctx, { filter, sort: { id: 'score', desc: true }, page: 1, pageSize: 6 })).rows : [],
    };
  });
}

// ── Questions ──────────────────────────────────────────────────────

function isSettled(c: Criteria, s: Slot, v?: Vocab) {
  if (c.settled.includes(s)) return true;
  // Never ask about something the catalog has no data for.
  if (v && s === 'industry' && !v.industries.length && !v.sources.length && !v.campaigns.length) return true;
  if (v && s === 'location' && !v.countries.length && !v.states.length) return true;
  if (v?.caps && s === 'quality' && !v.caps.scored && !v.caps.titled) return true;
  switch (s) {
    case 'industry': return c.industries.length > 0 || c.campaigns.length > 0 || c.sources.length > 0 || c.keywords.length > 0;
    case 'location': return c.countries.length > 0 || c.states.length > 0 || (c.cities?.length ?? 0) > 0;
    case 'quality': return c.minScore != null || c.seniority.length > 0 || c.priorities.length > 0;
    case 'musthave': return c.freshOnly || c.needEmail || c.needPhone || c.addedWithinDays != null;
    case 'quantity': return c.quantity != null;
  }
}

async function question(tx: Tx, c: Criteria, s: Slot, v: Vocab): Promise<{ text: string; replies: QuickReply[]; multi: boolean }> {
  const any = { label: 'Any', action: { type: 'skip' as const, slot: s } };
  const facet = async (field: 'industry' | 'country' | 'state' | 'source', prefix = '') => {
    const rest = field === 'industry' || field === 'source' ? { ...c, industries: [], sources: [] } : { ...c, countries: [], states: [] };
    return (await tx.lead.groupBy({ by: [field], where: { AND: [whereFor(rest), { [field]: { not: null } }] }, _count: true, orderBy: { _count: { [field]: 'desc' } }, take: 8 }))
      .map((r) => ({ label: `${r[field]} · ${r._count}`, action: { type: 'choose' as const, slot: s, values: [`${prefix}${r[field] as string}`] } }));
  };
  switch (s) {
    case 'industry':
      return v.industries.length
        ? { text: 'Which industry are your ideal prospects in?', replies: [...(await facet('industry')), any], multi: true }
        : { text: 'Which lead source works best for you?', replies: [...(await facet('source', 'src:')), any], multi: true };
    case 'location':
      return v.countries.length
        ? { text: 'Where should they be located?', replies: [...(await facet('country')), any], multi: true }
        : { text: 'Which state or region should they be in?', replies: [...(await facet('state', 'state:')), any], multi: true };
    case 'quality': return {
      text: v.caps?.scored ? 'How qualified should they be? Higher scores convert better but cost a little more.' : 'Which seniority are you targeting?',
      replies: [
        ...(v.caps?.scored !== false ? [{ label: 'Hot (score 80+)', action: { type: 'choose', slot: s, values: ['score:80'] } }, { label: 'Warm (65+)', action: { type: 'choose', slot: s, values: ['score:65'] } }] as QuickReply[] : []),
        ...(v.caps?.titled !== false ? [{ label: 'Decision-makers', action: { type: 'choose', slot: s, values: ['sen:Executive', 'sen:Director'] } }, { label: 'Managers', action: { type: 'choose', slot: s, values: ['sen:Manager'] } }] as QuickReply[] : []),
        any,
      ], multi: false,
    };
    case 'musthave': return {
      text: 'Any must-haves?',
      replies: [
        { label: 'Has a phone number', action: { type: 'choose', slot: s, values: ['phone'] } },
        { label: 'Has an email', action: { type: 'choose', slot: s, values: ['email'] } },
        { label: 'Never offered before', action: { type: 'choose', slot: s, values: ['fresh'] } },
        { label: 'Added this week', action: { type: 'choose', slot: s, values: ['week'] } },
        { label: 'No, show results', action: { type: 'skip', slot: s } },
      ], multi: true,
    };
    case 'quantity': return {
      text: 'How many leads do you need?',
      replies: [...[10, 25, 50, 100, 250].map((n): QuickReply => ({ label: String(n), action: { type: 'choose', slot: s, values: [String(n)] } })), { label: 'Just show me', action: { type: 'skip', slot: s } }],
      multi: false,
    };
  }
}

function applyChoice(c: Criteria, slot: Slot, values: string[]): Criteria {
  const n = structuredClone(c);
  const plain = (xs: string[]) => xs.filter((x) => !/^(src|state):/.test(x));
  if (slot === 'industry') n.industries = [...new Set([...n.industries, ...plain(values)])];
  if (slot === 'industry') n.sources = [...new Set([...n.sources, ...values.filter((x) => x.startsWith('src:')).map((x) => x.slice(4))])];
  if (slot === 'location') n.countries = [...new Set([...n.countries, ...plain(values)])];
  if (slot === 'location') n.states = [...new Set([...n.states, ...values.filter((x) => x.startsWith('state:')).map((x) => x.slice(6))])];
  if (slot === 'quantity') n.quantity = Math.max(1, Math.min(5000, Number(values[0]) || 0)) || null;
  for (const v of values) {
    if (slot === 'quality' && v.startsWith('score:')) n.minScore = Number(v.slice(6));
    if (slot === 'quality' && v.startsWith('sen:')) n.seniority = [...new Set([...n.seniority, v.slice(4) as Criteria['seniority'][number]])];
    if (slot === 'musthave') {
      if (v === 'phone') n.needPhone = true;
      if (v === 'email') n.needEmail = true;
      if (v === 'fresh') n.freshOnly = true;
      if (v === 'week') n.addedWithinDays = 7;
    }
  }
  n.settled = [...new Set([...n.settled, slot])];
  return n;
}

// ── FAQ ────────────────────────────────────────────────────────────

export const FAQ = [
  { id: 'how', q: 'What can you help me with?' },
  { id: 'free', q: 'How do free demo leads work?' },
  { id: 'pricing', q: 'How is pricing calculated?' },
  { id: 'visibility', q: 'What can I see before requesting a lead?' },
  { id: 'coupons', q: 'Do I have any coupons?' },
  { id: 'approval', q: 'How fast are leads delivered?' },
  { id: 'exclusive', q: 'Are the leads exclusive to me?' },
] as const;

async function faqAnswer(ctx: AuthContext, id: string): Promise<string> {
  const p = await getPricing();
  const s = await billingSummary(ctx);
  switch (id) {
    case 'free': return `Every workspace gets **${s.allowance.total} free demo leads**. You have **${s.allowance.remaining} left**. They are applied automatically to the highest-priced leads in a request, and a request covered entirely by free leads is ${p.autoApproveFree ? 'delivered instantly' : 'delivered after a quick review'}.`;
    case 'pricing': {
      const rules = [...describeDynamic(p.dynamic).map((r) => `• ${r.name}: ${r.description}`), ...p.rules.filter((r) => r.enabled).map((r) => `• ${r.name}: ${describeRule(r, p.currency)}`)].join('\n');
      const tiers = p.volumeTiers.length ? `\nVolume discounts: ${[...p.volumeTiers].sort((a, b) => a.minQty - b.minQty).map((t) => `${t.minQty}+ paid leads → ${t.discountPct}% off`).join(', ')}.` : '';
      return `A standard lead costs **${money(p.basePrice * 100, p.currency)}**.${rules ? `\n${rules}` : ''}${tiers}${p.taxPct ? `\nTax: ${p.taxPct}%.` : ''}\nYou always see the exact total — free leads, discounts and coupons included — before you confirm.`;
    }
    case 'visibility': return 'Before a lead is yours you can see its **industry, location, source, campaign, score, priority, seniority, when it was added and whether it has an email or phone**. Names, companies and contact details unlock in **My leads** as soon as the lead is delivered.';
    case 'coupons': {
      const cs = await availableCoupons(ctx.orgId!);
      if (!cs.length) return 'You have no coupons available right now. If you received a code, enter it in the request dialog.';
      return `You have **${cs.length} coupon${cs.length === 1 ? '' : 's'}** available:\n${cs.map((c) => `• **${c.code}** — ${couponLabel(c, p.currency)}${c.minLeads ? ` (min. ${c.minLeads} leads)` : ''}${c.endsAt ? `, until ${new Date(c.endsAt).toISOString().slice(0, 10)}` : ''}`).join('\n')}\nChoose one in the request dialog — the discount is shown before you confirm.`;
    }
    case 'approval': return `${p.autoApproveFree ? 'Free demo leads are delivered **instantly**.' : 'Free demo leads are delivered after a quick review.'} ${p.autoApprovePaid ? 'Paid requests are delivered **instantly** too.' : 'Paid requests are reviewed by the platform team; the leads are reserved for you meanwhile and you are only billed for what is delivered.'}`;
    case 'exclusive': return 'Yes. Once delivered, a lead belongs to your workspace only — it is removed from the marketplace and never offered to anyone else while it is yours.';
    default: return 'Tell me who you want to reach and I will find matching leads. For example:\n• “Decision-makers in real estate in the US with phone numbers”\n• “50 fresh solar leads added this week, score above 70”\n• “Insurance leads in Canada under $200”\nI will ask a couple of quick questions to narrow it down, then show you matches you can request in one click.';
  }
}

// ── Claude engine ──────────────────────────────────────────────────

const CLAUDE_MODEL = process.env.AI_MODEL || 'claude-opus-5-5';

const strArr = (d: string) => ({ type: 'array', items: { type: 'string' }, description: d });
/** Strict JSON schema of the criteria Claude returns (mirrors criteriaSchema). */
const CRITERIA_JSON = {
  type: 'object', additionalProperties: false,
  properties: {
    industries: strArr('Catalog industry values to include'), countries: strArr('Catalog countries'), states: strArr('Catalog states/regions'), cities: strArr('Catalog cities'),
    sources: strArr('Catalog lead sources'), campaigns: strArr('Catalog campaigns'),
    excludeIndustries: strArr('Industries to exclude'), excludeCountries: strArr('Countries to exclude'), excludeStates: strArr('States to exclude'), excludeCities: strArr('Cities to exclude'),
    keywords: strArr('Up to 3 lowercase business niche terms not in the industry list, e.g. "roofing"'),
    seniority: { type: 'array', items: { type: 'string', enum: ['Executive', 'Director', 'Manager', 'Professional'] } },
    priorities: { type: 'array', items: { type: 'string', enum: ['URGENT', 'HIGH', 'MEDIUM', 'LOW'] } },
    minScore: { type: ['integer', 'null'] }, maxScore: { type: ['integer', 'null'] },
    freshOnly: { type: 'boolean' }, addedWithinDays: { type: ['integer', 'null'] }, needEmail: { type: 'boolean' }, needPhone: { type: 'boolean' },
    quantity: { type: ['integer', 'null'] }, budget: { type: ['number', 'null'] },
  },
  required: ['industries', 'countries', 'states', 'cities', 'sources', 'campaigns', 'excludeIndustries', 'excludeCountries', 'excludeStates', 'excludeCities', 'keywords', 'seniority', 'priorities', 'minScore', 'maxScore', 'freshOnly', 'addedWithinDays', 'needEmail', 'needPhone', 'quantity', 'budget'],
} as const;

const SYSTEM_RULES = [
  'You are the Lead Finder for a B2B lead marketplace. You turn what a buyer says into precise search criteria over the leads that are available right now, and help them get to a great, non-empty result fast.',
  'How to read requests:',
  '- Return the COMPLETE criteria after this turn (start from the current criteria; change only what the user changed).',
  '- "instead", "only", "what about X", "switch to X" REPLACE that dimension; "and X", "also X" ADD to it.',
  '- "not / except / excluding / without / other than" go into the exclude* fields, never the include fields.',
  '- "remove the phone filter", "any location", "any industry" clear that dimension.',
  '- Decision-makers = Executive + Director. Owners, founders, CEOs, MDs, proprietors = Executive. VPs, heads, GMs = Director.',
  '- "hot/best/top" → minScore 80; "warm/qualified/good quality" → minScore 65. "fresh/exclusive/never sold" → freshOnly. "this week" → addedWithinDays 7.',
  '- Use ONLY values that exist in the catalog, spelled exactly. The lists below are the most common values; call find_values for anything else (cities, smaller industries, typos, local names like Bangalore → Bengaluru). If the catalog has no such value, use keywords for business niches or tell the user what is closest.',
  '- Always call count_leads on your final criteria before answering. Never present a search with 0 results as done: find which constraint to relax (count alternatives) and offer the best option.',
  'How to talk: friendly, concise (max ~60 words), concrete numbers from count_leads. Ask at most ONE clarifying question per turn, only if it meaningfully narrows a large result (> 200) — prefer location, then industry, then seniority/score. Never ask about something already answered or skipped (see settled). If the request is clear, set show_results=true.',
  'You never see individual leads, names or contact details and must not invent any. Finish every turn by calling respond.',
].join('\n');

async function claudeTurn(input: FinderInput, vocab: Vocab, counter: (c: Criteria) => Promise<number>, hint: Criteria | null): Promise<{ reply: string; criteria: Criteria; ask: { slot: Slot } | null; show: boolean } | null> {
  const key = process.env.AI_PROVIDER_API_KEY;
  if (!key) return null;
  const client = new Anthropic({ apiKey: key });
  const list = (xs: { value: string; count: number }[], n: number) => `${xs.slice(0, n).map((x) => `${x.value} (${x.count})`).join('; ')}${xs.length > n ? ` … +${xs.length - n} more (use find_values)` : ''}`;
  const catalog = [
    `Catalog — industries: ${list(vocab.industries, 60)}.`, `Countries: ${list(vocab.countries, 40)}.`, `States/regions: ${list(vocab.states, 60)}.`, `Cities: ${list(vocab.cities, 40)}.`,
    `Sources: ${list(vocab.sources, 30)}.`, `Campaigns: ${list(vocab.campaigns, 30)}.`,
    `Data available: ${vocab.caps?.scored ? 'lead scores' : 'no lead scores'}, ${vocab.caps?.titled ? 'job titles (seniority works)' : 'no job titles (do not filter by seniority)'}.`,
  ].join('\n');
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: SYSTEM_RULES },
    { type: 'text', text: catalog, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Current criteria: ${JSON.stringify(input.criteria)}${hint ? `\nA rule-based parser read the latest message as: ${JSON.stringify(hint)} — use it as a hint, correct it where it is wrong.` : ''}` },
  ];
  const tools: Anthropic.Tool[] = [
    { name: 'count_leads', description: 'Count available leads matching criteria. Returns a number and the top industries/locations of the matches.', input_schema: { type: 'object', properties: { criteria: CRITERIA_JSON }, required: ['criteria'] } as Anthropic.Tool.InputSchema },
    { name: 'find_values', description: 'Look up catalog values (with lead counts) for a free-text term — e.g. a city, a local place name, a niche industry, a typo.', input_schema: { type: 'object', properties: { field: { type: 'string', enum: ['industries', 'countries', 'states', 'cities', 'sources', 'campaigns'] }, query: { type: 'string' } }, required: ['field', 'query'] } },
    {
      name: 'respond', description: 'Reply to the user and set the final criteria. Always call this to end the turn.',
      input_schema: { type: 'object', properties: { message: { type: 'string' }, criteria: CRITERIA_JSON, ask_slot: { type: 'string', enum: [...SLOTS, 'none'], description: 'Slot your question is about, or none' }, show_results: { type: 'boolean', description: 'true when the criteria are specific enough to show matches' } }, required: ['message', 'criteria', 'ask_slot', 'show_results'] } as Anthropic.Tool.InputSchema,
    },
  ];
  const messages: Anthropic.MessageParam[] = [
    ...input.history.slice(-12).map((h) => ({ role: h.role, content: h.text }) as Anthropic.MessageParam),
    { role: 'user', content: input.message ?? (input.action?.type === 'search' ? 'Show me the matching leads.' : 'Continue.') },
  ];
  while (messages.length && messages[0].role !== 'user') messages.shift();
  const parse = (x: unknown) => {
    const parsed = criteriaSchema.safeParse({ ...input.criteria, ...(x as object), settled: input.criteria.settled });
    return parsed.success ? sanitize(parsed.data, vocab) : null;
  };
  for (let i = 0; i < 6; i++) {
    const res = await client.messages.create({ model: CLAUDE_MODEL, max_tokens: 1500, system, tools, tool_choice: i === 5 ? { type: 'tool', name: 'respond' } : { type: 'any' }, messages });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const respond = uses.find((u) => u.name === 'respond');
    if (respond) {
      const inp = respond.input as { message: string; criteria: unknown; ask_slot: string; show_results: boolean };
      const crit = parse(inp.criteria) ?? input.criteria;
      return { reply: String(inp.message ?? '').slice(0, 1200), criteria: crit, ask: inp.ask_slot && inp.ask_slot !== 'none' ? { slot: inp.ask_slot as Slot } : null, show: Boolean(inp.show_results) };
    }
    messages.push({ role: 'assistant', content: res.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      if (u.name === 'find_values') {
        const { field, query } = u.input as { field: keyof Vocab; query: string };
        const pool = (vocab[field] as { value: string; count: number }[] | undefined) ?? [];
        const hits = findValues(String(query ?? ''), pool, field === 'industries' ? 'industry' : field === 'sources' || field === 'campaigns' ? 'plain' : 'place');
        toolResults.push({ type: 'tool_result', tool_use_id: u.id, content: hits.length ? hits.map((h) => `${h.value} (${h.count})`).join('; ') : `No ${field} value matches "${query}". Closest: ${closest(String(query ?? ''), pool).join(', ') || 'none'}` });
        continue;
      }
      const crit = parse((u.input as { criteria?: object }).criteria ?? {});
      if (!crit) { toolResults.push({ type: 'tool_result', tool_use_id: u.id, content: 'Invalid criteria', is_error: true }); continue; }
      const n = await counter(crit);
      const dropped = JSON.stringify((u.input as { criteria?: object }).criteria ?? {}) !== JSON.stringify(crit) ? ` (values not in the catalog were mapped or removed: ${describeCriteria(crit).join(', ') || 'no filters'})` : '';
      toolResults.push({ type: 'tool_result', tool_use_id: u.id, content: `${n} leads match${dropped}` });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return null;
}

// ── Turn orchestration ─────────────────────────────────────────────

export async function finderTurn(ctx: AuthContext, input: FinderInput) {
  const ai = await aiStatus();
  const useClaude = ai.enabled && (!ai.provider || /anthropic|claude/i.test(ai.provider));
  const vocab = await withPlatform((tx) => vocabulary(tx));
  let c = sanitize(input.criteria, vocab);
  let reply = '';
  let wantResults = false;
  let pendingSlot: Slot | null = null;
  const a = input.action;

  if (a?.type === 'start' || (!a && !input.message)) {
    const total = await withPlatform((tx) => tx.lead.count({ where: MARKET_AVAILABLE }));
    const topInd = vocab.industries[0]?.value;
    const topCountry = vocab.countries[0]?.value;
    const topState = vocab.states[0]?.value;
    return {
      engine: useClaude ? 'claude' : 'built-in',
      reply: `Hi! I’m your **Lead Finder**. ${total ? `There are **${total.toLocaleString()} leads** available right now.` : 'No leads are available at this moment, but I can still answer questions.'} Tell me who you’re looking for — or pick a starting point below.`,
      criteria: emptyCriteria(), chips: describeCriteria(emptyCriteria()), question: null,
      quickReplies: [
        ...(topInd ? [{ label: vocab.caps?.titled ? `Decision-makers in ${topInd}` : `${topInd} leads`, message: vocab.caps?.titled ? `Decision-makers in ${topInd}` : `${topInd} leads` }] : []),
        { label: 'Fresh leads added this week', message: 'Fresh leads added this week' },
        ...(topCountry && vocab.caps?.scored ? [{ label: `Hot leads in ${topCountry}`, message: `Hot leads in ${topCountry} with score above 80` }] : topCountry ? [{ label: `Leads in ${topCountry}`, message: `Leads in ${topCountry}` }] : []),
        ...(!topCountry && topState ? [{ label: `Leads in ${topState}`, message: `Leads in ${topState}` }] : []),
        { label: 'Leads with phone numbers', message: 'Leads with phone numbers' },
      ] as QuickReply[],
      faq: FAQ, results: null,
    };
  }
  if (a?.type === 'reset') {
    return { engine: useClaude ? 'claude' : 'built-in', reply: 'Cleared. Who are you looking for this time?', criteria: emptyCriteria(), chips: [], question: null, quickReplies: [], faq: FAQ, results: null };
  }
  if (a?.type === 'faq') {
    return { engine: 'built-in', reply: await faqAnswer(ctx, a.id), criteria: c, chips: describeCriteria(c), question: null, quickReplies: [{ label: 'Find leads', action: { type: 'start' } }] as QuickReply[], faq: FAQ, results: null };
  }
  if (a?.type === 'choose') { c = applyChoice(c, a.slot, a.values); }
  if (a?.type === 'skip') { c = { ...c, settled: [...new Set([...c.settled, a.slot])] }; if (a.slot === 'musthave' || a.slot === 'quantity') wantResults = true; }
  if (a?.type === 'search') wantResults = true;
  if (a?.type === 'relax') { c = sanitize(a.criteria, vocab); wantResults = true; }

  // Natural language: Claude when enabled, otherwise the built-in parser.
  if (input.message) {
    const lastAsk = [...input.history].reverse().find((h) => h.role === 'assistant')?.text ?? '';
    const pending: Slot | null = /industry/i.test(lastAsk) ? 'industry' : /located|location/i.test(lastAsk) ? 'location' : /qualified|score/i.test(lastAsk) ? 'quality' : /must-have/i.test(lastAsk) ? 'musthave' : /how many/i.test(lastAsk) ? 'quantity' : null;
    let handled = false;
    if (useClaude) {
      try {
        const hint = understand(input.message, vocab, c, pending).criteria;
        const r = await claudeTurn({ ...input, criteria: c }, vocab, (x) => withPlatform((tx) => count(tx, x)), hint);
        if (r) {
          c = r.criteria;
          reply = r.reply;
          wantResults = r.show;
          pendingSlot = r.ask?.slot ?? null;
          handled = true;
        }
      } catch (err) {
        logger.warn({ err }, 'lead finder: Claude unavailable, using built-in engine');
      }
    }
    if (!handled) {
      const u = understand(input.message, vocab, c, pending);
      if (u.intent.reset) return finderTurn(ctx, { ...input, message: null, action: { type: 'reset' } });
      if (u.intent.faq && !u.intent.changed.length) return finderTurn(ctx, { ...input, message: null, action: { type: 'faq', id: u.intent.faq } });
      c = u.criteria;
      const kw = await keywordPass(input.message, c, vocab); c = kw.criteria; if (kw.added.length) u.intent.changed.push('industry');
      if (u.intent.skip && pending) c.settled = [...new Set([...c.settled, pending])];
      c.settled = [...new Set([...c.settled, ...u.intent.changed.filter((x): x is Slot => (SLOTS as readonly string[]).includes(x))])];
      wantResults ||= u.intent.search;
      const notes = noteFor(u.intent, kw.missing);
      const generic = /\b(leads?|prospects?|customers?|clients?|help|find|need|want|looking|show|get)\b/i.test(input.message) && input.message.split(/\s+/).length <= 6;
      if (!u.intent.changed.length && !u.intent.removed.length && !u.intent.search && !u.intent.skip && !u.intent.unavailable.length) reply = notes || (generic ? 'Happy to help you find the right leads.' : 'I couldn’t match that to the leads available. Try a location, an industry or must-haves like phone numbers — or pick one of the options below.');
      else if (u.intent.changed.length || u.intent.removed.length) reply = `${notes ? `${notes} ` : ''}Got it — ${describeCriteria(c).join(', ') || 'any leads'}.`;
      if (u.intent.unavailable.length) reply = `There are no leads from ${u.intent.unavailable.join(' or ')} available right now${vocab.countries.length ? ` — available countries include ${vocab.countries.slice(0, 4).map((x) => x.value).join(', ')}` : ''}. ${reply}`.trim();
    }
  }

  const settledCount = SLOTS.filter((s) => isSettled(c, s, vocab)).length;
  const next = pendingSlot ?? SLOTS.find((s) => !isSettled(c, s, vocab)) ?? null;
  const { n, q } = await withPlatform(async (tx) => {
    const n = await count(tx, c);
    // Show results when asked, when there are few enough to look at, or once the key questions are settled.
    const show = wantResults || n === 0 || n <= 15 || settledCount >= 4 || (!next && settledCount > 0);
    return { n, q: !show && next ? await question(tx, c, next, vocab) : null };
  });
  const res = q ? null : await results(ctx, c);
  {
    const lead = n === 1 ? 'lead' : 'leads';
    let text = reply;
    if (res) {
      if (!res.total) text = `${reply ? `${reply} ` : ''}No available leads match all of that right now.${res.relax.length ? ' Here is what would work:' : ''}`;
      else text = `${reply ? `${reply} ` : ''}I found **${res.total.toLocaleString()} matching ${lead}**${res.avgScore ? ` (average score ${res.avgScore})` : ''}.${c.quantity && res.total > c.quantity ? ` Here are the best ${c.quantity}.` : ''}${res.withinBudget === false ? ' That is over your budget — try fewer leads or a lower score.' : ''}`;
    } else if (q) {
      text = `${reply ? `${reply} ` : ''}${n.toLocaleString()} ${lead} so far. ${q.text}`;
    }
    const replies: QuickReply[] = q ? q.replies : res?.total ? [
      ...(isSettled(c, 'quality', vocab) || !vocab.caps?.scored ? [] : [{ label: 'Only hot leads (80+)', action: { type: 'choose', slot: 'quality', values: ['score:80'] } } as QuickReply]),
      ...(c.needPhone ? [] : [{ label: 'Must have a phone', action: { type: 'choose', slot: 'musthave', values: ['phone'] } } as QuickReply]),
      ...(c.freshOnly ? [] : [{ label: 'Never offered before', action: { type: 'choose', slot: 'musthave', values: ['fresh'] } } as QuickReply]),
      { label: 'Start over', action: { type: 'reset' } },
    ] : (res?.relax ?? []).map((r) => ({ label: `${r.label} (${r.count})`, action: { type: 'relax', criteria: r.criteria } } as QuickReply)).concat([{ label: 'Start over', action: { type: 'reset' } }]);
    return { engine: useClaude ? 'claude' : 'built-in', reply: text, criteria: c, chips: describeCriteria(c), question: q ? { slot: next, multi: q.multi } : null, quickReplies: replies, faq: FAQ, results: res };
  }
}

// ── Public (onboarding forms) ──────────────────────────────────────

/**
 * Lead Finder for prospective clients on a public onboarding form. Built-in engine only, and only aggregate
 * numbers leave the server (no rows, prices or identities): enough to show what is available.
 */
export async function publicFinderTurn(input: FinderInput) {
  const vocab = await withPlatform((tx) => vocabulary(tx));
  let c = sanitize(input.criteria, vocab);
  let reply = '';
  let wantResults = false;
  const a = input.action;
  if (a?.type === 'start' || (!a && !input.message)) {
    const total = await withPlatform((tx) => tx.lead.count({ where: MARKET_AVAILABLE }));
    return { reply: `There are **${total.toLocaleString()} verified leads** available right now. Describe your ideal customers and I’ll show you how many match.`, criteria: emptyCriteria(), chips: [], quickReplies: [] as QuickReply[], summary: null };
  }
  if (a?.type === 'reset') return { reply: 'Cleared — who are you looking for?', criteria: emptyCriteria(), chips: [], quickReplies: [] as QuickReply[], summary: null };
  if (a?.type === 'choose') c = applyChoice(c, a.slot, a.values);
  if (a?.type === 'skip') { c = { ...c, settled: [...new Set([...c.settled, a.slot])] }; wantResults = true; }
  if (a?.type === 'relax') { c = sanitize(a.criteria, vocab); wantResults = true; }
  if (input.message) {
    const u = understand(input.message, vocab, c, null);
    c = u.criteria;
    const kw = await keywordPass(input.message, c, vocab); c = kw.criteria; if (kw.added.length) u.intent.changed.push('industry');
    c.settled = [...new Set([...c.settled, ...u.intent.changed.filter((x): x is Slot => (SLOTS as readonly string[]).includes(x))])];
    wantResults ||= u.intent.search;
    const notes = noteFor(u.intent, kw.missing);
    reply = u.intent.changed.length || u.intent.removed.length ? `${notes ? `${notes} ` : ''}Got it — ${describeCriteria(c).join(', ') || 'any leads'}.` : u.intent.unavailable.length ? `There are no leads from ${u.intent.unavailable.join(' or ')} right now.` : notes;
  }
  return withPlatform(async (tx) => {
    const n = await count(tx, c);
    const next = SLOTS.filter((s) => s !== 'quantity').find((s) => !isSettled(c, s, vocab)) ?? null;
    const ask = !wantResults && n > 25 && next ? await question(tx, c, next, vocab) : null;
    const where = whereFor(c);
    const g = async (field: 'industry' | 'country' | 'state') => (await tx.lead.groupBy({ by: [field], where: { AND: [where, { [field]: { not: null } }] }, _count: true, orderBy: { _count: { [field]: 'desc' } }, take: 4 })).map((r) => ({ label: r[field] as string, count: r._count }));
    const [industries, regions] = await Promise.all([g('industry'), vocab.countries.length ? g('country') : g('state')]);
    const text = `${reply ? `${reply} ` : ''}**${n.toLocaleString()} matching lead${n === 1 ? '' : 's'}** available.${ask ? ` ${ask.text}` : n ? ' Submit your application to get access — your first leads are free.' : ''}`;
    return {
      reply: text, criteria: c, chips: describeCriteria(c),
      quickReplies: ask ? ask.replies.slice(0, 7) : n === 0 ? (await relaxations(tx, c)).map((r) => ({ label: `${r.label} (${r.count})`, action: { type: 'relax', criteria: r.criteria } } as QuickReply)) : [],
      summary: { total: n, industries, regions },
    };
  });
}

// ── Public homepage (chat-first landing) ───────────────────────────

export const HOME_FAQ = [
  { id: 'how', q: 'How does this work?' },
  { id: 'free', q: 'Are the first leads really free?' },
  { id: 'visibility', q: 'What can I see before signing up?' },
  { id: 'approval', q: 'How fast do I get my leads?' },
  { id: 'pricing', q: 'What happens after the free leads?' },
  { id: 'exclusive', q: 'Are the leads exclusive?' },
] as const;

const HOME_SLOTS: Slot[] = ['industry', 'location', 'quality', 'musthave'];

const seniorityOf = (t: string | null) => {
  const s = (t ?? '').toLowerCase();
  if (!s) return null;
  if (/(chief|ceo|cfo|cto|coo|founder|owner|president|partner)/.test(s)) return 'Executive';
  if (/(vp|vice president|director|head)/.test(s)) return 'Director';
  if (/(manager|lead)/.test(s)) return 'Manager';
  return 'Professional';
};

async function homeFaqAnswer(id: string, opts: { autoApprove: boolean }) {
  const p = await getPricing();
  const free = p.freeLeadsPerClient;
  switch (id) {
    case 'free': return free
      ? `Yes — your first **${free} leads are free**. No payment and no card. Find the leads you want here, claim them with a 1-minute sign-up, and they’re delivered to your private dashboard as soon as your workspace is ready.`
      : 'Sign up to get your own workspace — you’ll see the exact price of every lead before you request it.';
    case 'visibility': return 'Before sign-up you can see each match’s **industry, location, seniority, score, freshness and whether it has an email or phone**. Names, companies and contact details unlock in your dashboard once the leads are delivered to you.';
    case 'approval': return opts.autoApprove
      ? `Your workspace is activated **instantly**. Set your password from the email we send you and your ${free ? `${free} free leads are` : 'leads are'} waiting in your dashboard.`
      : `Every new business is reviewed by our team — usually within **one business day**. ${free ? `Your ${free} free leads are delivered the moment you’re activated.` : ''}`.trim();
    case 'pricing': return `After your free leads, a standard lead costs **${money(p.basePrice * 100, p.currency)}**${p.volumeTiers.length ? ', with volume discounts' : ''}. You always see the exact total before you confirm — nothing is ever charged automatically.`;
    case 'exclusive': return 'Yes. Once a lead is delivered to you it belongs to your workspace only — it is removed from the marketplace and never offered to anyone else while it is yours.';
    case 'coupons': return 'Coupons and offers appear in your dashboard after you sign up.';
    default: return `Tell me who you want to reach — industry, location, seniority, must-haves — and I’ll search the live catalog.\n• I ask a quick question or two to sharpen the search\n• You see real matches (contact details hidden)\n• ${free ? `Claim your **${free} free leads**` : 'Claim your leads'} with a short sign-up — they land in your private dashboard.`;
  }
}

/** Headline numbers for the homepage hero (aggregates only). */
export async function catalogHeadline() {
  return withPlatform(async (tx) => {
    const v = await vocabulary(tx);
    const total = await tx.lead.count({ where: MARKET_AVAILABLE });
    return { total, industries: v.industries.length, regions: v.countries.length || v.states.length, free: (await getPricing()).freeLeadsPerClient };
  });
}

/**
 * Lead Finder as the public homepage. Same engines as the client finder (Claude when enabled, which only sees
 * aggregate counts), but results are limited to aggregates plus a handful of masked previews — never names,
 * companies, contact details, sources or prices.
 */
export async function homeFinderTurn(input: FinderInput, opts: { autoApprove: boolean }) {
  const ai = await aiStatus();
  const useClaude = ai.enabled && (!ai.provider || /anthropic|claude/i.test(ai.provider));
  const engine = useClaude ? 'claude' : 'built-in';
  const vocab = await withPlatform((tx) => vocabulary(tx));
  const free = (await getPricing()).freeLeadsPerClient;
  let c = sanitize(input.criteria, vocab);
  let reply = '';
  let wantResults = false;
  let pendingSlot: Slot | null = null;
  const a = input.action;
  const base = { engine, faq: HOME_FAQ, free };

  if (a?.type === 'start' || (!a && !input.message)) {
    const total = await withPlatform((tx) => tx.lead.count({ where: MARKET_AVAILABLE }));
    return { ...base, reply: `Hi! I search **${total.toLocaleString()} verified leads** for you. Who are your ideal customers?`, criteria: emptyCriteria(), chips: [], quickReplies: [] as QuickReply[], question: null, results: null };
  }
  if (a?.type === 'reset') return { ...base, reply: 'Fresh start — who are you looking for?', criteria: emptyCriteria(), chips: [], quickReplies: [] as QuickReply[], question: null, results: null };
  if (a?.type === 'faq') return { ...base, reply: await homeFaqAnswer(a.id, opts), criteria: c, chips: describeCriteria(c), quickReplies: [] as QuickReply[], question: null, results: null };
  if (a?.type === 'choose') c = applyChoice(c, a.slot, a.values);
  if (a?.type === 'skip') { c = { ...c, settled: [...new Set([...c.settled, a.slot])] }; if (a.slot === 'musthave') wantResults = true; }
  if (a?.type === 'search') wantResults = true;
  if (a?.type === 'relax') { c = sanitize(a.criteria, vocab); wantResults = true; }

  if (input.message) {
    const lastAsk = [...input.history].reverse().find((h) => h.role === 'assistant')?.text ?? '';
    const pending: Slot | null = /industry/i.test(lastAsk) ? 'industry' : /located|location/i.test(lastAsk) ? 'location' : /qualified|score|seniority/i.test(lastAsk) ? 'quality' : /must-have/i.test(lastAsk) ? 'musthave' : null;
    let handled = false;
    // FAQ-style questions are answered from live settings, whichever engine is on.
    const probe = understand(input.message, vocab, c, pending);
    if (probe.intent.faq && !probe.intent.changed.length) return { ...base, reply: await homeFaqAnswer(probe.intent.faq, opts), criteria: c, chips: describeCriteria(c), quickReplies: [] as QuickReply[], question: null, results: null };
    if (/\b(free|no (payment|card)|trial)\b/i.test(input.message) && !probe.intent.changed.length) return { ...base, reply: await homeFaqAnswer('free', opts), criteria: c, chips: describeCriteria(c), quickReplies: [] as QuickReply[], question: null, results: null };
    if (useClaude) {
      try {
        const r = await claudeTurn({ ...input, criteria: c }, vocab, (x) => withPlatform((tx) => count(tx, x)), probe.criteria);
        if (r) { c = r.criteria; reply = r.reply; wantResults = r.show; pendingSlot = r.ask && r.ask.slot !== 'quantity' ? r.ask.slot : null; handled = true; }
      } catch (err) {
        logger.warn({ err }, 'home finder: Claude unavailable, using built-in engine');
      }
    }
    if (!handled) {
      const u = probe;
      if (u.intent.reset) return homeFinderTurn({ ...input, message: null, action: { type: 'reset' } }, opts);
      c = u.criteria;
      const kw = await keywordPass(input.message, c, vocab); c = kw.criteria; if (kw.added.length) u.intent.changed.push('industry');
      if (u.intent.skip && pending) c.settled = [...new Set([...c.settled, pending])];
      c.settled = [...new Set([...c.settled, ...u.intent.changed.filter((x): x is Slot => (SLOTS as readonly string[]).includes(x))])];
      wantResults ||= u.intent.search;
      const notes = noteFor(u.intent, kw.missing);
      if (!u.intent.changed.length && !u.intent.removed.length && !u.intent.search && !u.intent.skip && !u.intent.unavailable.length) reply = notes || 'Happy to help — let’s narrow it down.';
      else if (u.intent.changed.length || u.intent.removed.length) reply = `${notes ? `${notes} ` : ''}Got it — ${describeCriteria(c).join(', ') || 'any leads'}.`;
      if (u.intent.unavailable.length) reply = `There are no leads from ${u.intent.unavailable.join(' or ')} available right now${vocab.countries.length ? ` — we have ${vocab.countries.slice(0, 4).map((x) => x.value).join(', ')}` : ''}. ${reply}`.trim();
    }
  }

  const settledCount = HOME_SLOTS.filter((s) => isSettled(c, s, vocab)).length;
  const next = pendingSlot ?? HOME_SLOTS.find((s) => !isSettled(c, s, vocab)) ?? null;
  return withPlatform(async (tx) => {
    const where = whereFor(c);
    const n = await tx.lead.count({ where });
    const show = wantResults || n === 0 || n <= 25 || settledCount >= 3 || (!next && settledCount > 0);
    const q = !show && next ? await question(tx, c, next, vocab) : null;
    let results = null;
    if (!q) {
      const g = async (field: 'industry' | 'country' | 'state') => (await tx.lead.groupBy({ by: [field], where: { AND: [where, { [field]: { not: null } }] }, _count: true, orderBy: { _count: { [field]: 'desc' } }, take: 5 })).map((r) => ({ label: r[field] as string, count: r._count }));
      const [industries, regions, agg, withEmail, withPhone, fresh, top] = await Promise.all([
        g('industry'), vocab.countries.length ? g('country') : g('state'),
        tx.lead.aggregate({ where, _avg: { score: true } }),
        tx.lead.count({ where: { AND: [where, { emailNormalized: { not: null } }] } }),
        tx.lead.count({ where: { AND: [where, { phoneNormalized: { not: null } }] } }),
        tx.lead.count({ where: { AND: [where, { distributionCount: 0 }] } }),
        tx.lead.findMany({ where, orderBy: [{ score: 'desc' }, { createdAt: 'desc' }], take: 6, select: { id: true, country: true, state: true, industry: true, score: true, createdAt: true, distributionCount: true, emailNormalized: true, phoneNormalized: true, jobTitle: true } }),
      ]);
      results = {
        total: n, avgScore: Math.round(agg._avg.score ?? 0), withEmail, withPhone, fresh,
        breakdown: { industries, regions },
        sample: top.map((l) => ({
          ref: `LD-${l.id.slice(-6).toUpperCase()}`, industry: l.industry, country: l.country, state: l.state, seniority: seniorityOf(l.jobTitle), score: l.score,
          fresh: l.distributionCount === 0, hasEmail: Boolean(l.emailNormalized), hasPhone: Boolean(l.phoneNormalized), addedDays: Math.max(0, Math.floor((Date.now() - l.createdAt.getTime()) / 86_400_000)),
        })),
        relax: n === 0 ? await relaxations(tx, c) : [],
        claimable: Math.min(free, n),
      };
    }
    const lead = n === 1 ? 'lead' : 'leads';
    let text = reply;
    if (results) {
      text = !n
        ? `${reply ? `${reply} ` : ''}Nothing matches all of that right now.${results.relax.length ? ' These would work:' : ''}`
        : `${reply ? `${reply} ` : ''}I found **${n.toLocaleString()} matching ${lead}**${results.avgScore ? ` with an average score of ${results.avgScore}` : ''}.${free ? ` Your first **${Math.min(free, n)}** are free — no payment needed.` : ''}`;
    } else if (q) text = `${reply ? `${reply} ` : ''}**${n.toLocaleString()}** ${lead} so far. ${q.text}`;
    const quickReplies: QuickReply[] = q ? q.replies.slice(0, 8)
      : n ? [
        ...(c.needPhone ? [] : [{ label: 'Must have a phone', action: { type: 'choose', slot: 'musthave', values: ['phone'] } } as QuickReply]),
        ...(c.minScore != null || !vocab.caps?.scored ? [] : [{ label: 'Only hot leads (80+)', action: { type: 'choose', slot: 'quality', values: ['score:80'] } } as QuickReply]),
        ...(c.freshOnly ? [] : [{ label: 'Never offered before', action: { type: 'choose', slot: 'musthave', values: ['fresh'] } } as QuickReply]),
        { label: 'Start over', action: { type: 'reset' } },
      ] : (results?.relax ?? []).map((r) => ({ label: `${r.label} (${r.count})`, action: { type: 'relax', criteria: r.criteria } } as QuickReply)).concat([{ label: 'Start over', action: { type: 'reset' } }]);
    return { ...base, reply: text, criteria: c, chips: describeCriteria(c), quickReplies, question: q ? { slot: next, multi: q.multi } : null, results };
  }, { timeout: 30_000 });
}

/** Best-scoring available leads for saved criteria, relaxing optional constraints when nothing matches. */
export async function topMatchIds(criteria: Criteria, n: number) {
  if (n <= 0) return [];
  return withPlatform(async (tx) => {
    const tries: Criteria[] = [criteria, { ...criteria, minScore: null, seniority: [], priorities: [], freshOnly: false, addedWithinDays: null }, { ...emptyCriteria(), industries: criteria.industries, countries: criteria.countries, states: criteria.states }, { ...emptyCriteria(), industries: criteria.industries }];
    for (const c of tries) {
      const rows = await tx.lead.findMany({ where: whereFor(c), orderBy: [{ score: 'desc' }, { createdAt: 'desc' }], take: n, select: { id: true } });
      if (rows.length) return rows.map((r) => r.id);
    }
    return [];
  });
}
