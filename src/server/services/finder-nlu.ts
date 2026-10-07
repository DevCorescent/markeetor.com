import { z } from 'zod';

/**
 * Lead Finder language understanding (works offline; also gives Claude a first reading of each message).
 *
 * Turns free text into search criteria against the live catalog vocabulary:
 *  - industries, countries, states/regions and cities — exact phrases, synonyms/concepts, aliases
 *    (Bangalore → Bengaluru, USA → United States) and typo tolerance;
 *  - exclusions ("not in Kerala", "except insurance", "no real estate");
 *  - replacing vs adding ("Canada instead", "what about Pune?", "only Delhi") and removing
 *    ("remove the phone filter", "any location");
 *  - numbers in any form ("50", "fifty", "1.5k", "2,000", "two hundred"), scores ("70+", "score above 70"),
 *    budgets ("under ₹5,000", "budget 200 dollars"), recency ("last 2 weeks"), seniority, must-haves.
 */

const SENIORITY = ['Executive', 'Director', 'Manager', 'Professional'] as const;
const PRIORITIES = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'] as const;
const strs = z.array(z.string().trim().min(1).max(120)).max(25).default([]);

export const criteriaSchema = z.object({
  industries: strs, countries: strs, states: strs, cities: strs, sources: strs, campaigns: strs,
  /** Exclusions ("not in Kerala", "except insurance"). */
  excludeIndustries: strs, excludeCountries: strs, excludeStates: strs, excludeCities: strs,
  /** Business keywords matched against industries and AI enrichment ("roofing", "dental clinic"). */
  keywords: z.array(z.string().trim().toLowerCase().min(2).max(60)).max(5).default([]),
  seniority: z.array(z.enum(SENIORITY)).max(4).default([]),
  priorities: z.array(z.enum(PRIORITIES)).max(4).default([]),
  minScore: z.number().int().min(0).max(100).nullable().default(null),
  maxScore: z.number().int().min(0).max(100).nullable().default(null),
  freshOnly: z.boolean().default(false),
  addedWithinDays: z.number().int().min(1).max(365).nullable().default(null),
  needEmail: z.boolean().default(false),
  needPhone: z.boolean().default(false),
  quantity: z.number().int().min(1).max(5000).nullable().default(null),
  budget: z.number().min(0).max(10_000_000).nullable().default(null),
  /** Slots the user already answered or skipped — never asked again. */
  settled: z.array(z.string().max(30)).max(20).default([]),
});
export type Criteria = z.infer<typeof criteriaSchema>;
export const emptyCriteria = (): Criteria => criteriaSchema.parse({});

export const SLOTS = ['industry', 'location', 'quality', 'musthave', 'quantity'] as const;
export type Slot = (typeof SLOTS)[number];

export type VocabItem = { value: string; count: number };
export type Vocab = Record<'industries' | 'countries' | 'states' | 'cities' | 'sources' | 'campaigns', VocabItem[]> & { caps?: { scored: boolean; titled: boolean } };

// ── Text helpers ───────────────────────────────────────────────────

/** Like norm, but keeps currency signs (for budgets). */
const normText = (s: string) => s.toLowerCase().replace(/(\d),(?=\d)/g, '$1').replace(/[’']/g, '').replace(/([,;!?])/g, ' $1 ').replace(/[^a-z0-9&+.,;!?\s$€£₹-]/g, ' ').replace(/\s+/g, ' ').trim();
export const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9&+.\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const hasPhrase = (text: string, phrase: string) => Boolean(phrase) && new RegExp(`(^|[^a-z0-9])${esc(phrase)}([^a-z0-9]|$)`).test(text);
const tokens = (t: string) => t.split(' ').filter(Boolean);

/** Edit distance, capped (returns cap+1 when larger). */
export function lev(a: string, b: string, cap = 2) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}
/** Typo tolerance grows with word length: 5–7 letters → 1 edit, 8+ → 2. */
const typoOk = (a: string, b: string) => a.length >= 5 && b.length >= 5 && lev(a, b, a.length >= 8 && b.length >= 8 ? 2 : 1) <= (a.length >= 8 && b.length >= 8 ? 2 : 1);

const SMALL: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, dozen: 12, couple: 2,
};
const SCALE: Record<string, number> = { hundred: 100, thousand: 1000, lakh: 100_000, lakhs: 100_000, lac: 100_000, million: 1_000_000 };

/** "two hundred fifty" → 250, "1.5k" → 1500, "2,000" → 2000, "a dozen" → 12. */
export function normaliseNumbers(text: string) {
  let t = text.replace(/(\d),(?=\d{2,3}\b)/g, '$1');
  t = t.replace(/\b(\d+(?:\.\d+)?)\s*k\b/g, (_, n: string) => String(Math.round(Number(n) * 1000)));
  t = t.replace(/\b(\d+(?:\.\d+)?)\s*(lakhs?|lac)\b/g, (_, n: string) => String(Math.round(Number(n) * 100_000)));
  const words = t.split(/(\s+)/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!(w in SMALL) && !(w in SCALE)) { out.push(w); continue; }
    // "a"/"an" only count when followed by a number word ("a hundred", "a dozen").
    if ((w === 'a' || w === 'an') && !(words[i + 2] in SCALE || words[i + 2] === 'dozen')) { out.push(w); continue; }
    let total = 0, cur = 0, j = i, used = false;
    while (j < words.length) {
      const x = words[j];
      if (/^\s+$/.test(x)) { j++; continue; }
      if (x === 'and' && used) { j++; continue; }
      if (x in SMALL) { cur += SMALL[x] === 12 && x === 'dozen' ? (cur || 1) * 12 - cur : SMALL[x]; used = true; j++; continue; }
      if (x in SCALE) { cur = (cur || 1) * SCALE[x]; if (SCALE[x] >= 1000) { total += cur; cur = 0; } used = true; j++; continue; }
      break;
    }
    if (!used) { out.push(w); continue; }
    out.push(String(total + cur), ' ');
    i = j - 1;
  }
  return out.join('').replace(/\s+/g, ' ');
}

// ── Concepts & aliases ─────────────────────────────────────────────

/** keys: words that identify the concept inside a catalog value; says: what people type. */
const CONCEPTS: { keys: string[]; says: string[] }[] = [
  { keys: ['real estate', 'realty', 'property'], says: ['property', 'properties', 'realty', 'realtor', 'realtors', 'real-estate', 'housing', 'brokerage', 'brokers', 'builders', 'developers', 'flats', 'apartments', 'plots', 'mortgage'] },
  { keys: ['insurance'], says: ['insurer', 'insurers', 'insurance', 'policy', 'policies', 'life cover', 'health cover'] },
  { keys: ['healthcare', 'health', 'medical', 'hospital', 'clinic', 'pharma'], says: ['health', 'healthcare', 'medical', 'hospital', 'hospitals', 'clinic', 'clinics', 'doctor', 'doctors', 'dental', 'dentist', 'diagnostic', 'diagnostics', 'nursing'] },
  { keys: ['pharma', 'pharmaceutical'], says: ['pharma', 'pharmaceutical', 'pharmaceuticals', 'drug', 'drugs', 'medicines', 'chemist'] },
  { keys: ['education', 'edtech', 'school', 'training'], says: ['edtech', 'school', 'schools', 'university', 'universities', 'college', 'colleges', 'training', 'coaching', 'tuition', 'institute', 'institutes', 'students', 'academy'] },
  { keys: ['automotive', 'automobile', 'auto'], says: ['auto', 'autos', 'car', 'cars', 'dealership', 'dealerships', 'vehicle', 'vehicles', 'automobile', 'two wheeler', 'ev', 'showroom'] },
  { keys: ['financial', 'finance', 'banking', 'fintech', 'bank'], says: ['finance', 'financial', 'banking', 'bank', 'banks', 'fintech', 'loans', 'loan', 'lending', 'nbfc', 'wealth', 'investment', 'investments', 'mutual fund', 'stock broking', 'accounting', 'accountants', 'ca firms', 'tax'] },
  { keys: ['retail', 'ecommerce', 'e-commerce'], says: ['ecommerce', 'e-commerce', 'shop', 'shops', 'store', 'stores', 'retailer', 'retailers', 'd2c', 'online store'] },
  { keys: ['solar', 'energy', 'renewable', 'power'], says: ['solar', 'energy', 'renewable', 'renewables', 'pv', 'electricity', 'power', 'rooftop', 'inverter', 'ev charging'] },
  { keys: ['hospitality', 'hotel', 'travel', 'tourism', 'restaurant'], says: ['hotel', 'hotels', 'travel', 'tourism', 'restaurant', 'restaurants', 'resort', 'resorts', 'cafe', 'cafes', 'tour operators', 'travel agents'] },
  { keys: ['technology', 'software', 'saas', 'it ', 'information technology', 'it development', 'it services'], says: ['tech', 'software', 'saas', 'cloud', 'developer', 'developers', 'it services', 'it companies', 'it firms', 'web development', 'app development', 'startups', 'startup', 'digital'] },
  { keys: ['construction', 'infrastructure', 'contractor', 'building'], says: ['construction', 'contractors', 'contractor', 'civil', 'infrastructure', 'infra', 'cement', 'steel', 'architects', 'interiors', 'interior design'] },
  { keys: ['manufacturing', 'industrial', 'factory'], says: ['manufacturing', 'manufacturers', 'manufacturer', 'factory', 'factories', 'industrial', 'plant', 'plants', 'machinery', 'msme', 'oem'] },
  { keys: ['logistics', 'transport', 'shipping', 'freight', 'supply chain'], says: ['logistics', 'transport', 'transporters', 'shipping', 'freight', 'courier', 'couriers', 'warehousing', 'warehouse', 'fleet', 'trucking', 'supply chain', 'cargo'] },
  { keys: ['legal', 'law'], says: ['legal', 'law firm', 'law firms', 'lawyer', 'lawyers', 'advocates', 'attorneys', 'attorney'] },
  { keys: ['marketing', 'advertising', 'media', 'agency'], says: ['marketing', 'advertising', 'ad agency', 'agencies', 'media', 'pr', 'branding', 'digital marketing', 'seo'] },
  { keys: ['food', 'beverage', 'fmcg'], says: ['food', 'foods', 'beverage', 'beverages', 'fmcg', 'bakery', 'dairy', 'snacks', 'catering'] },
  { keys: ['fitness', 'wellness', 'gym', 'sports'], says: ['fitness', 'gym', 'gyms', 'wellness', 'yoga', 'sports', 'spa'] },
  { keys: ['beauty', 'cosmetic', 'salon'], says: ['beauty', 'salon', 'salons', 'cosmetics', 'skincare', 'parlour'] },
  { keys: ['fashion', 'apparel', 'textile', 'garment', 'clothing'], says: ['fashion', 'apparel', 'apparels', 'textile', 'textiles', 'garments', 'garment', 'clothing', 'boutique', 'boutiques'] },
  { keys: ['agriculture', 'agri', 'farming'], says: ['agriculture', 'agri', 'farming', 'farmers', 'agritech', 'seeds', 'fertilizer', 'fertilizers'] },
  { keys: ['telecom', 'telecommunication'], says: ['telecom', 'telecommunications', 'isp', 'broadband', 'internet providers'] },
  { keys: ['consulting', 'professional services', 'advisory'], says: ['consulting', 'consultants', 'consultancy', 'advisory', 'advisors'] },
  { keys: ['staffing', 'recruitment', 'hr', 'human resources'], says: ['staffing', 'recruitment', 'recruiters', 'hiring', 'placement', 'manpower', 'hr services'] },
  { keys: ['jewellery', 'jewelry'], says: ['jewellery', 'jewelry', 'jewellers', 'jewelers', 'gold', 'diamonds'] },
  { keys: ['furniture', 'furnishing'], says: ['furniture', 'furnishing', 'furnishings', 'decor', 'home decor'] },
  { keys: ['electronics', 'electrical'], says: ['electronics', 'electrical', 'appliances', 'gadgets'] },
  { keys: ['events', 'event', 'wedding'], says: ['events', 'event management', 'wedding planners', 'weddings', 'event planners'] },
  { keys: ['non-profit', 'nonprofit', 'ngo'], says: ['ngo', 'ngos', 'non profit', 'nonprofit', 'charity', 'charities', 'trust'] },
  { keys: ['security'], says: ['security', 'security services', 'guards', 'cctv', 'surveillance', 'cybersecurity'] },
];

const PLACE_ALIASES: Record<string, string[]> = {
  'united states': ['usa', 'u.s.', 'u.s.a', 'u s', 'america', 'american', 'the us', 'the states', 'us based', 'in us'],
  'united kingdom': ['uk', 'u.k.', 'britain', 'great britain', 'england', 'british'],
  'united arab emirates': ['uae', 'emirates'],
  india: ['indian', 'bharat', 'pan india', 'all india'], canada: ['canadian'], australia: ['aussie', 'australian'], germany: ['german'], france: ['french'], singapore: ['sg', 'singaporean'],
  bengaluru: ['bangalore', 'blr'], mumbai: ['bombay', 'navi mumbai'], chennai: ['madras'], kolkata: ['calcutta'], pune: ['poona'], gurugram: ['gurgaon'], delhi: ['new delhi', 'ncr', 'delhi ncr', 'dilli'],
  hyderabad: ['hyd', 'secunderabad'], thiruvananthapuram: ['trivandrum'], kochi: ['cochin'], mysuru: ['mysore'], vadodara: ['baroda'], prayagraj: ['allahabad'], dubai: ['dxb'],
  maharashtra: ['mh'], karnataka: ['ka'], 'tamil nadu': ['tn', 'tamilnadu'], 'uttar pradesh': ['up'], 'west bengal': ['wb', 'bengal'], 'andhra pradesh': ['ap'], telangana: ['ts'], gujarat: ['gj'], rajasthan: ['rj'], kerala: ['kl'],
  california: ['cali', 'socal', 'norcal'], 'new york': ['nyc', 'ny'], texas: ['tx'], florida: ['fl'],
};
/** Short aliases that are also ordinary words only count when typed in capitals (UP, AP, NY…). */
const CASE_SENSITIVE_ALIASES = new Set(['up', 'ap', 'ts', 'tn', 'wb', 'mh', 'ka', 'kl', 'gj', 'rj', 'ny', 'tx', 'fl', 'sg', 'hyd', 'blr', 'us', 'u s']);

/** Words describing people, not industries — never fuzzy-matched to an industry. */
const ROLE_WORDS = new Set(['manager', 'managers', 'director', 'directors', 'head', 'heads', 'owner', 'owners', 'executive', 'executives', 'founder', 'founders', 'partner', 'partners', 'lead', 'leads', 'president', 'staff', 'officer', 'officers', 'management', 'leaders', 'leader', 'professional', 'professionals', 'people', 'decision', 'makers', 'buyers', 'contacts', 'prospects']);
const STOP = new Set(['and', 'the', 'for', 'with', 'services', 'service', 'group', 'other', 'others', 'company', 'companies', 'industry', 'sector', 'business', 'businesses']);

/**
 * Catalog values mentioned in the text: exact phrase, concept/alias, or a typo of a meaningful token.
 * `raw` is the original message (for capitalised short aliases).
 */
export function matchValues(text: string, values: VocabItem[], opts: { concepts?: boolean; aliases?: boolean; raw?: string; fuzzy?: boolean } = {}) {
  const t = norm(text);
  const tw = tokens(t);
  const found = new Set<string>();
  for (const { value } of values) {
    const v = norm(value);
    if (!v) continue;
    if (v.length >= 2 && hasPhrase(t, v)) { found.add(value); continue; }
    if (opts.aliases) {
      const al = PLACE_ALIASES[v] ?? [];
      if (al.some((a) => (CASE_SENSITIVE_ALIASES.has(a) ? Boolean(opts.raw && new RegExp(`(^|[^A-Za-z])${esc(a.toUpperCase())}([^A-Za-z]|$)`).test(opts.raw)) : hasPhrase(t, a)))) { found.add(value); continue; }
    }
    if (opts.concepts) {
      const cs = CONCEPTS.filter((c) => c.keys.some((k) => hasPhrase(v, k.trim()) || v === k.trim()));
      if (cs.some((c) => c.says.some((s) => hasPhrase(t, s)))) { found.add(value); continue; }
    }
    if (opts.fuzzy !== false) {
      const vt = tokens(v).filter((w) => w.length >= 4 && !STOP.has(w));
      const hit = vt.some((tok) => tw.some((w) => {
        if (ROLE_WORDS.has(w) || STOP.has(w)) return false;
        if (w === tok || w === `${tok}s` || `${w}s` === tok) return true;
        if (typoOk(w, tok)) return true;
        // "pharma" → "pharmaceuticals": the typed word is a long-enough prefix of the catalog word.
        return w.length >= 6 && tok.startsWith(w);
      }));
      if (hit) found.add(value);
    }
  }
  return [...found];
}

/** True when a phrase is a known concept word (so it's already covered by the industry match). */
export const isConceptPhrase = (w: string) => CONCEPTS.some((c) => c.says.includes(w) || c.says.includes(`${w}s`) || c.keys.includes(w));

// ── Understanding a message ────────────────────────────────────────

export type Intent = { search: boolean; reset: boolean; skip: boolean; faq: string | null; changed: string[]; removed: string[]; excluded: string[]; unavailable: string[]; replaced: boolean };

/** Every country name the runtime knows, so we can say "none from X right now" instead of ignoring it. */
const ALL_COUNTRIES: string[] = (() => {
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    const out: string[] = [];
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = dn.of(code);
      if (name && name !== code && !/unknown/i.test(name)) out.push(name);
    }
    return out;
  } catch {
    return [];
  }
})();

const NEG = /\b(?:not|no|except|excluding|exclude|without|other than|but not|apart from|outside(?: of)?|avoid|skip)\b/g;
const NEG_BREAK = /[,.;!?]|\b(?:but|with|who|that|which|having|and (?:with|has|have|only|in|from)|in the last|added|score|under|below|above|over)\b/;
const NOT_REALLY_NEG = /\b(?:not sure|no preference|no idea|doesn'?t matter|no matter|no limit|not important|no budget)\b/;

/** Splits the message into exclusion clauses and the remaining (positive) text. */
function splitNegations(t: string) {
  const excl: string[] = [];
  let pos = t;
  if (NOT_REALLY_NEG.test(t)) return { pos: t, excl };
  for (const m of [...t.matchAll(NEG)]) {
    const start = m.index! + m[0].length;
    const rest = t.slice(start);
    const end = rest.search(NEG_BREAK);
    const clause = (end === -1 ? rest : rest.slice(0, end)).split(' ').filter(Boolean).slice(0, 6).join(' ');
    if (clause.trim()) { excl.push(clause.trim()); pos = pos.replace(`${m[0]} ${clause}`, ' ').replace(`${m[0]}${clause}`, ' '); }
  }
  return { pos, excl: excl.map((e) => e.replace(/^(?:in|from|any|the|a)\s+/, '')) };
}

const merge = (prev: string[], next: string[], replace: boolean) => [...new Set([...(replace ? [] : prev), ...next])];

export function understand(message: string, v: Vocab, prev: Criteria, pending: Slot | null): { criteria: Criteria; intent: Intent } {
  const c: Criteria = structuredClone(prev);
  for (const k of ['cities', 'excludeIndustries', 'excludeCountries', 'excludeStates', 'excludeCities'] as const) c[k] ??= [];
  const raw = message;
  const t = ` ${normaliseNumbers(normText(message))} `;
  const intent: Intent = { search: false, reset: false, skip: false, faq: null, changed: [], removed: [], excluded: [], unavailable: [], replaced: false };
  const set = <K extends keyof Criteria>(k: K, val: Criteria[K], slot: string) => { c[k] = val; if (!intent.changed.includes(slot)) intent.changed.push(slot); };

  if (/\b(reset|start over|start again|clear (all|everything)|new search|from scratch)\b/.test(t)) { intent.reset = true; return { criteria: emptyCriteria(), intent }; }
  if (/\b(show|search|find them|results|go ahead|thats (it|all)|done|list them|lets see|see (the )?leads|show me|display)\b/.test(t)) intent.search = true;
  if (/^\s*(any|anything|any is fine|anywhere|doesnt matter|no preference|skip|not sure|all|either|whatever|any one)\s*$/.test(t.trim()) || NOT_REALLY_NEG.test(t)) intent.skip = true;
  if (/\b(price|pricing|cost|how much|rate card)\b/.test(t) && !/\b(under|below|budget|within|max)\b/.test(t)) intent.faq = 'pricing';
  if (/\bfree\b.*\b(lead|demo)s?\b|\bdemo leads?\b/.test(t)) intent.faq = 'free';
  if (/\b(coupon|promo|discount code|offer code)\b/.test(t)) intent.faq = 'coupons';
  if (/\b(what (can|do) i see|hidden|why.*(hidden|masked)|contact details hidden)\b/.test(t)) intent.faq = 'visibility';
  if (/\b(how long|how fast|approval|approve|delivery time)\b/.test(t)) intent.faq = 'approval';
  const replace = /\b(instead|only|switch to|change (it |that )?to|what about|how about|rather|just in|just from|replace)\b/.test(t);
  intent.replaced = replace;

  // ── Removing filters (the phrases are then cut out, so "remove the phone filter" never adds one) ──
  const removed: string[] = [];
  const hit = (re: RegExp) => { const m = re.exec(t); if (m) removed.push(m[0]); return Boolean(m); };
  const remove = (what: RegExp) => hit(new RegExp(`\\b(?:remove|drop|clear|forget|delete|reset|undo|dont need|do not need|no longer need|without the|ignore)\\s+(?:the\\s+|my\\s+|that\\s+|all\\s+)?(?:${what.source})\\w*(?:\\s+(?:filters?|requirements?|condition))?`));
  const any = (what: RegExp) => hit(new RegExp(`\\b(?:any|all)\\s+(?:${what.source})\\w*\\b`));
  if (remove(/phone|mobile|calling/)) { c.needPhone = false; intent.removed.push('phone'); }
  if (remove(/e-?mail/)) { c.needEmail = false; intent.removed.push('email'); }
  if (remove(/score|quality|rating/) || any(/score|quality/)) { c.minScore = null; c.maxScore = null; intent.removed.push('score'); }
  if (remove(/seniority|level|title|designation/) || any(/seniority|level|designation/)) { c.seniority = []; intent.removed.push('seniority'); }
  if (remove(/location|country|countries|state|states|city|cities|region|place/) || any(/location|country|state|city|region|place|where/) || /\banywhere\b/.test(t)) {
    c.countries = []; c.states = []; c.cities = []; c.excludeCountries = []; c.excludeStates = []; c.excludeCities = []; intent.removed.push('location');
  }
  if (remove(/industry|industries|sector|niche|keyword/) || any(/industry|industries|sector/)) { c.industries = []; c.keywords = []; c.excludeIndustries = []; intent.removed.push('industry'); }
  if (remove(/fresh|exclusive/)) { c.freshOnly = false; intent.removed.push('fresh'); }
  if (remove(/date|recency|time|days?/) || any(/time|date/)) { c.addedWithinDays = null; intent.removed.push('date'); }
  if (remove(/budget/) || /\bno budget\b/.test(t)) { c.budget = null; intent.removed.push('budget'); }
  if (remove(/quantity|limit|count|number of leads/)) { c.quantity = null; intent.removed.push('quantity'); }
  if (remove(/filters?|everything|all filters/)) { const e = emptyCriteria(); Object.assign(c, { ...e, settled: [] }); intent.removed.push('all'); }

  // ── Exclusions ("not in Kerala", "except insurance", "no real estate") ──
  let rest = t;
  for (const r of removed) rest = rest.replace(r, ' ');
  const { pos, excl } = splitNegations(rest);
  for (const clause of excl) {
    if (/\b(phone|mobile|calls?)\b/.test(clause)) { c.needPhone = false; continue; }
    if (/\be-?mails?\b/.test(clause)) { c.needEmail = false; continue; }
    const xi = matchValues(clause, v.industries, { concepts: true });
    const xc = matchValues(clause, v.countries, { aliases: true, raw });
    const xs = matchValues(clause, v.states, { aliases: true, raw }).filter((s) => !xc.includes(s));
    const xt = matchValues(clause, v.cities, { aliases: true, raw, fuzzy: false }).filter((s) => !xs.includes(s) && !xc.includes(s));
    if (xi.length) { c.excludeIndustries = merge(c.excludeIndustries, xi, false); c.industries = c.industries.filter((x) => !xi.includes(x)); intent.excluded.push(...xi); set('excludeIndustries', c.excludeIndustries, 'industry'); }
    if (xc.length) { c.excludeCountries = merge(c.excludeCountries, xc, false); c.countries = c.countries.filter((x) => !xc.includes(x)); intent.excluded.push(...xc); set('excludeCountries', c.excludeCountries, 'location'); }
    if (xs.length) { c.excludeStates = merge(c.excludeStates, xs, false); c.states = c.states.filter((x) => !xs.includes(x)); intent.excluded.push(...xs); set('excludeStates', c.excludeStates, 'location'); }
    if (xt.length) { c.excludeCities = merge(c.excludeCities, xt, false); c.cities = c.cities.filter((x) => !xt.includes(x)); intent.excluded.push(...xt); set('excludeCities', c.excludeCities, 'location'); }
    if (/\b(sold|offered|distributed|used|shared|resold)\b/.test(clause)) set('freshOnly', true, 'musthave');
  }
  const p = ` ${pos} `;

  // ── Places & industries (positive text only) ──
  const ind = matchValues(p, v.industries, { concepts: true });
  if (ind.length) set('industries', merge(c.industries, ind, replace), 'industry');
  const ctry = matchValues(p, v.countries, { aliases: true, raw });
  const sts = matchValues(p, v.states, { aliases: true, raw }).filter((s) => !ctry.includes(s));
  // A name that is both a state and a city (Delhi) is treated as the state — it covers the city.
  const cts = matchValues(p, v.cities, { aliases: true, raw, fuzzy: false }).filter((s) => !sts.some((x) => norm(x) === norm(s)) && !ctry.some((x) => norm(x) === norm(s)));
  if (ctry.length || sts.length || cts.length) {
    // Switching place: "Canada instead" replaces the whole location; "and Pune" adds.
    const r = replace;
    // A new place makes old place exclusions meaningless ("not Mumbai" while switching to Karnataka).
    if (r) { c.excludeStates = []; c.excludeCities = []; }
    if (ctry.length) set('countries', merge(r ? [] : c.countries, ctry, r), 'location');
    else if (r) c.countries = [];
    if (sts.length) set('states', merge(r ? [] : c.states, sts, r), 'location');
    else if (r) c.states = [];
    if (cts.length) set('cities', merge(r ? [] : c.cities, cts, r), 'location');
    else if (r) c.cities = [];
  }
  const known = new Set(v.countries.map((x) => x.value.toLowerCase()));
  intent.unavailable = !v.countries.length ? [] : ALL_COUNTRIES.filter((name) => name.length > 3 && !known.has(name.toLowerCase()) && hasPhrase(p, norm(name)) && !ctry.some((m) => norm(m).includes(norm(name))) && !sts.some((s) => norm(s) === norm(name)));
  const src = matchValues(p, v.sources, { fuzzy: false });
  if (src.length && !ind.length) set('sources', merge(c.sources, src, replace), 'source');
  const camp = matchValues(p, v.campaigns, { fuzzy: false }).filter((x) => x.length >= 4);
  if (camp.length) set('campaigns', merge(c.campaigns, camp, replace), 'campaign');

  // ── Numbers ──
  const num = (re: RegExp) => { const m = re.exec(t); return m ? Number(m[1]) : null; };
  const LEADWORD = '(?:leads?|prospects?|contacts?|decision[- ]makers?|companies|buyers?|businesses|records|people|clients?|customers?|owners?|ceos?|founders?|directors?|managers?)';
  let q = num(new RegExp(`\\b(\\d{1,5})\\s*(?:[a-z&-]+\\s+){0,4}?${LEADWORD}\\b`)) ?? num(/\b(?:need|want|get|find|show(?: me)?|about|around|give me|buy|purchase|send(?: me)?|approx(?:imately)?)\s+(\d{1,5})\b(?!\s*(?:%|\+|days?|weeks?|months?|score|points|rs|inr|dollars|usd|rupees))/);
  if (q != null && (q > 5000 || q === 0)) q = null;
  // A number that is clearly money or a score is never a quantity.
  if (q != null && new RegExp(`(?:[$€£₹]|rs\\.?|inr|budget|under|below|within|score|above|over)\\s*${q}\\b`).test(t)) q = null;
  if (q) set('quantity', q, 'quantity');
  if (pending === 'quantity' && !q) { const n = num(/^\s*(\d{1,4})\s*$/); if (n) set('quantity', n, 'quantity'); }

  const maxS = num(/\bscore\s*(?:of\s*)?(?:below|under|<=?|at most|max(?:imum)?|less than|lower than)\s*(\d{1,3})\b/) ?? num(/\b(?:below|under|less than)\s*(\d{1,3})\s*(?:score|points)\b/);
  const minS = maxS != null ? null
    : num(/\bscore\s*(?:of\s*)?(?:above|over|>=?|at least|min(?:imum)?|more than|greater than|higher than|from)?\s*(\d{1,3})\s*(?:\+|plus|or (?:more|above|higher|better))?(?!\s*(?:leads?|%|days?))/)
      ?? num(/\b(\d{2,3})\s*(?:\+|plus)?\s*(?:score|points|rated)\b/) ?? num(/\b(?:above|over|at least|minimum|more than)\s*(\d{2,3})\s*(?:score|points)\b/) ?? num(/\b(\d{2,3})\s*\+\s*(?:quality|rating)\b/);
  if (minS != null && minS <= 100) set('minScore', minS, 'quality');
  if (maxS != null && maxS <= 100) set('maxScore', maxS, 'quality');
  if (minS == null && maxS == null && /\b(hot|high[- ]quality|high[- ]intent|best|top|qualified|premium|warm|good quality|serious)\b/.test(pos)) set('minScore', /\b(hot|best|top|premium)\b/.test(pos) ? 80 : 65, 'quality');

  // A budget needs a currency or the word budget/spend, so "score under 50" is never read as money.
  const cur = '(?:[$€£₹]|rs\\.?|inr|usd|eur|gbp)';
  const bm = new RegExp(`(?:budget(?:\\s*(?:of|is))?|spend(?:ing)?|within|up ?to|under|below|max(?:imum)?|not more than|less than)\\s*(${cur})?\\s*(\\d{2,8})\\s*(rupees|dollars|rs|inr|usd)?`).exec(t);
  let budget = bm && (bm[1] || bm[3] || /budget|spend|within/.test(bm[0])) && !/score|points/.test(t.slice(bm.index, bm.index + bm[0].length + 8)) ? Number(bm[2]) : null;
  budget ??= num(new RegExp(`${cur}\\s*(\\d{2,8})`)) ?? num(/\b(\d{2,8})\s*(?:rupees|dollars|bucks)\b/);
  if (budget) set('budget', budget, 'quantity');

  // ── Recency, freshness, must-haves ──
  const rel = /\b(?:last|past|previous|within(?: the)?(?: last)?|in the last)\s+(\d{1,3})\s*(days?|weeks?|months?)\b/.exec(t);
  if (rel) set('addedWithinDays', Math.min(365, Number(rel[1]) * (rel[2].startsWith('week') ? 7 : rel[2].startsWith('month') ? 30 : 1)), 'musthave');
  else if (/\b(today|last 24 hours|past day|yesterday)\b/.test(t)) set('addedWithinDays', /yesterday/.test(t) ? 2 : 1, 'musthave');
  else if (/\b(this week|last week|past week|recent(ly)?|latest|new(est)? leads?|just added)\b/.test(t)) set('addedWithinDays', 7, 'musthave');
  else if (/\b(this month|last month|past month)\b/.test(t)) set('addedWithinDays', 30, 'musthave');
  if (/\b(fresh|exclusive|untouched|unused|never (been )?(sold|contacted|distributed|offered|used)|brand new|first[- ]hand)\b/.test(pos)) set('freshOnly', true, 'musthave');
  if (/\b(e-?mails?|inbox|mail ids?)\b/.test(pos)) set('needEmail', true, 'musthave');
  if (/\b(phone|phones|call|calls|calling|mobile|cell|telephone|whatsapp|dial|numbers?|contact numbers?)\b/.test(pos) && !/\b(\d+\s+numbers?)\b/.test(pos)) set('needPhone', true, 'musthave');
  if (/\b(contact details|full contacts?|complete details|reachable)\b/.test(pos)) { set('needPhone', true, 'musthave'); set('needEmail', true, 'musthave'); }

  // ── Seniority & priority ──
  const sen = new Set(replace && /\b(only|just)\b/.test(t) ? [] : c.seniority);
  const before = [...c.seniority].sort().join();
  if (/\b(decision[- ]makers?|buyers?|budget holders?|key people|top management|leadership)\b/.test(pos)) { sen.add('Executive'); sen.add('Director'); }
  if (/\b(c-?level|c-?suite|cxos?|executives?|ceos?|cfos?|ctos?|coos?|cmos?|founders?|co-?founders?|owners?|proprietors?|presidents?|partners?|chairman|chairperson|mds?|managing directors?|principals?|promoters?)\b/.test(pos)) sen.add('Executive');
  if (/\b(directors?|vps?|vice presidents?|heads? of|hods?|general managers?|gms?|avps?)\b/.test(pos) && !/\bmanaging directors?\b/.test(pos)) sen.add('Director');
  if (/\b(managers?|team leads?|supervisors?|team leaders?)\b/.test(pos) && !/\bgeneral managers?\b/.test(pos)) sen.add('Manager');
  if (/\b(individual contributors?|staff|employees?|executives? level|associates?)\b/.test(pos)) sen.add('Professional');
  if ([...sen].sort().join() !== before) set('seniority', [...sen], 'quality');
  if (/\burgent\b/.test(pos)) set('priorities', ['URGENT'], 'quality');
  else if (/\bhigh[- ]priority\b/.test(pos)) set('priorities', ['URGENT', 'HIGH'], 'quality');

  if (intent.skip && pending) intent.changed.push(pending);
  return { criteria: c, intent };
}

// ── Mapping AI or stale values onto the catalog ────────────────────

/** Canonical catalog spelling for a value: exact (case-insensitive), alias/concept, then typo match. */
export function canonical(x: string, pool: VocabItem[], kind: 'industry' | 'place' | 'plain') {
  const n = norm(x);
  const exact = pool.find((p) => norm(p.value) === n);
  if (exact) return exact.value;
  const m = matchValues(x, pool, { concepts: kind === 'industry', aliases: kind === 'place', fuzzy: kind !== 'plain' });
  if (m.length === 1) return m[0];
  if (m.length > 1) return [...m].sort((a, b) => (pool.find((p) => p.value === b)?.count ?? 0) - (pool.find((p) => p.value === a)?.count ?? 0))[0];
  return null;
}

/** Keeps only catalog values (mapped to canonical spelling) — nothing the catalog doesn't have reaches a search. */
export function sanitize(c: Criteria, v: Vocab): Criteria {
  const keep = (xs: string[] | undefined, pool: VocabItem[], kind: 'industry' | 'place' | 'plain') => [...new Set((xs ?? []).map((x) => canonical(x, pool, kind)).filter((x): x is string => Boolean(x)))];
  return {
    ...c,
    industries: keep(c.industries, v.industries, 'industry'), countries: keep(c.countries, v.countries, 'place'), states: keep(c.states, v.states, 'place'), cities: keep(c.cities, v.cities, 'place'),
    sources: keep(c.sources, v.sources, 'plain'), campaigns: keep(c.campaigns, v.campaigns, 'plain'),
    excludeIndustries: keep(c.excludeIndustries, v.industries, 'industry'), excludeCountries: keep(c.excludeCountries, v.countries, 'place'), excludeStates: keep(c.excludeStates, v.states, 'place'), excludeCities: keep(c.excludeCities, v.cities, 'place'),
  };
}

/** Closest catalog values for a term that matched nothing (for "no X — closest are …"). */
export function closest(term: string, pool: VocabItem[], n = 3) {
  const t = norm(term);
  const viaConcept = matchValues(t, pool, { concepts: true, fuzzy: true });
  if (viaConcept.length) return viaConcept.slice(0, n);
  return pool
    .map((p) => ({ v: p.value, d: Math.min(...tokens(norm(p.value)).map((w) => lev(w, t, 3))) }))
    .filter((x) => x.d <= 3).sort((a, b) => a.d - b.d).slice(0, n).map((x) => x.v);
}

/** Finds catalog values for a free-text query (used by the AI's lookup tool). */
export function findValues(query: string, pool: VocabItem[], kind: 'industry' | 'place' | 'plain', n = 8) {
  const q = norm(query);
  const scored = pool.map((p) => {
    const v = norm(p.value);
    let s = 0;
    if (v === q) s = 100; else if (v.startsWith(q)) s = 80; else if (hasPhrase(v, q)) s = 70; else if (v.includes(q)) s = 60;
    else if (kind === 'place' && (PLACE_ALIASES[v] ?? []).some((a) => a.startsWith(q))) s = 75;
    else if (matchValues(q, [p], { concepts: kind === 'industry', aliases: kind === 'place' }).length) s = 50;
    return { value: p.value, count: p.count, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.count - a.count);
  return scored.slice(0, n).map(({ value, count }) => ({ value, count }));
}
