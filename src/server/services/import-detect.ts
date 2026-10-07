import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Smart import detection: figures out which spreadsheet column holds which lead field using the
 * header text AND the actual values, with an explainable confidence score per column. Also detects
 * delimiters, header rows and country names/codes so messy real-world files import with no setup.
 */

export type FieldKey =
  | 'fullName' | 'firstName' | 'lastName' | 'email' | 'phone' | 'secondaryPhone' | 'company' | 'jobTitle'
  | 'city' | 'state' | 'country' | 'industry' | 'source' | 'campaign' | 'score' | 'priority' | 'tags';

export const SYNONYMS: Record<FieldKey, string[]> = {
  fullName: ['name', 'full name', 'fullname', 'contact name', 'lead name', 'customer name', 'client name', 'person', 'contact', 'customer', 'lead', 'prospect', 'prospect name', 'your name', 'name of lead'],
  firstName: ['first name', 'firstname', 'fname', 'first', 'given name', 'forename'],
  lastName: ['last name', 'lastname', 'lname', 'last', 'surname', 'family name'],
  email: ['email', 'e mail', 'email address', 'emailaddress', 'mail', 'email id', 'mail id', 'work email', 'business email', 'primary email', 'contact email', 'e mail address'],
  phone: ['phone', 'phone number', 'phone no', 'phonenumber', 'mobile', 'mobile number', 'mobile no', 'mob', 'mob no', 'cell', 'cell phone', 'cellphone', 'telephone', 'tel', 'contact number', 'contact no', 'whatsapp', 'whatsapp number', 'number', 'ph', 'primary phone', 'work phone'],
  secondaryPhone: ['secondary phone', 'alternate phone', 'alternative phone', 'alt phone', 'phone 2', 'phone2', 'other phone', 'landline', 'home phone', 'office phone', 'alternate number', 'alt number', 'mobile 2'],
  company: ['company', 'company name', 'organization', 'organisation', 'org', 'business', 'business name', 'firm', 'employer', 'account', 'account name', 'brand'],
  jobTitle: ['job title', 'title', 'designation', 'position', 'role', 'job', 'job role', 'occupation'],
  city: ['city', 'town', 'locality', 'city name'],
  state: ['state', 'region', 'province', 'county', 'state province', 'territory'],
  country: ['country', 'nation', 'country name', 'country code', 'country region'],
  industry: ['industry', 'sector', 'vertical', 'business type', 'segment industry'],
  source: ['source', 'lead source', 'utm source', 'channel', 'origin', 'lead origin', 'acquisition channel', 'platform'],
  campaign: ['campaign', 'campaign name', 'utm campaign', 'ad name', 'ad set', 'adset', 'ad campaign'],
  score: ['score', 'lead score', 'rating', 'grade score'],
  priority: ['priority', 'urgency', 'temperature', 'lead temperature', 'hotness'],
  tags: ['tags', 'tag', 'labels', 'label', 'segment', 'segments', 'list', 'groups'],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const PRIORITY_WORDS = new Set(['low', 'medium', 'med', 'high', 'urgent', 'hot', 'warm', 'cold', 'critical', 'normal']);

const norm = (s: string) => s.toLowerCase().replace(/[_\-./()#:]+/g, ' ').replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

// ── Countries ──────────────────────────────────────────────────────

let countryIndex: Map<string, { code: string; name: string }> | null = null;
function countries() {
  if (countryIndex) return countryIndex;
  countryIndex = new Map();
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      // Only current, real regions (excludes historical/reserved codes such as DD, UK, EU).
      if (!isSupportedCountry(code)) continue;
      let name: string | undefined;
      try {
        name = names.of(code);
      } catch {
        continue;
      }
      if (!name || name === code || /unknown/i.test(name)) continue;
      countryIndex.set(code.toLowerCase(), { code, name });
      // First code wins for a name (e.g. GB before the reserved UK alias).
      if (!countryIndex.has(norm(name))) countryIndex.set(norm(name), { code, name });
    }
  }
  const alias: Record<string, string> = { usa: 'US', 'u s a': 'US', 'u s': 'US', america: 'US', 'united states of america': 'US', uk: 'GB', 'u k': 'GB', england: 'GB', britain: 'GB', 'great britain': 'GB', scotland: 'GB', wales: 'GB', uae: 'AE', emirates: 'AE', 'south korea': 'KR', korea: 'KR', russia: 'RU', 'czech republic': 'CZ', holland: 'NL', bharat: 'IN' };
  for (const [k, code] of Object.entries(alias)) {
    const hit = countryIndex.get(code.toLowerCase());
    if (hit) countryIndex.set(k, hit);
  }
  return countryIndex;
}

/** "us", "USA", "united states" → { code: 'US', name: 'United States' }. */
export function lookupCountry(raw: string | null | undefined) {
  if (!raw) return null;
  return countries().get(norm(raw)) ?? null;
}

// ── Column detection ───────────────────────────────────────────────

function lev(a: string, b: string) {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function headerScore(header: string, field: FieldKey): { score: number; reason: string | null } {
  const h = norm(header);
  if (!h) return { score: 0, reason: null };
  let best = 0;
  let reason: string | null = null;
  for (const syn of SYNONYMS[field]) {
    let s = 0;
    if (h === syn) s = 1;
    else if (h.split(' ').length > 1 && (` ${h} `.includes(` ${syn} `) && syn.length >= 4)) s = 0.78;
    else {
      const d = lev(h, syn);
      const sim = 1 - d / Math.max(h.length, syn.length);
      if (sim >= 0.82 && Math.min(h.length, syn.length) >= 4) s = 0.7;
    }
    if (s > best) {
      best = s;
      reason = s === 1 ? `Header “${header}” matches ${label(field)}` : `Header “${header}” resembles “${syn}”`;
    }
  }
  return { score: best, reason };
}

export const label = (f: FieldKey) =>
  ({ fullName: 'full name', firstName: 'first name', lastName: 'last name', email: 'email', phone: 'phone', secondaryPhone: 'secondary phone', company: 'company', jobTitle: 'job title', city: 'city', state: 'state', country: 'country', industry: 'industry', source: 'source', campaign: 'campaign', score: 'score', priority: 'priority', tags: 'tags' })[f];

type Profile = { n: number; email: number; phone: number; country: number; url: number; num0to100: number; priority: number; nameLike: number; avgLen: number; distinct: number; multiValue: number };

function profile(values: string[], defaultCountry: string): Profile {
  const v = values.map((x) => x.trim()).filter(Boolean).slice(0, 300);
  const n = v.length || 1;
  const ratio = (fn: (x: string) => boolean) => v.filter(fn).length / n;
  return {
    n: v.length,
    email: ratio((x) => EMAIL_RE.test(x)),
    phone: ratio((x) => {
      if (EMAIL_RE.test(x) || /[a-df-z]/i.test(x.replace(/ext|x/gi, ''))) return false;
      const digits = x.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) return false;
      return Boolean(parsePhoneNumberFromString(x.startsWith('00') ? `+${x.slice(2)}` : x, defaultCountry as CountryCode)?.isPossible());
    }),
    country: ratio((x) => Boolean(lookupCountry(x))),
    url: ratio((x) => URL_RE.test(x)),
    num0to100: ratio((x) => /^\d{1,3}(\.\d+)?$/.test(x) && Number(x) <= 100),
    priority: ratio((x) => PRIORITY_WORDS.has(x.toLowerCase())),
    // Personal names: 2–4 words, each capitalised (lower-case phrases like "follow up" are notes, not names).
    nameLike: ratio((x) => /^\p{Lu}[\p{L}'’.-]*(\s+\p{Lu}[\p{L}'’.-]*){1,3}$/u.test(x) && x.length <= 60),
    avgLen: v.reduce((s, x) => s + x.length, 0) / n,
    distinct: new Set(v.map((x) => x.toLowerCase())).size / n,
    multiValue: ratio((x) => /[,;|]/.test(x) && x.length < 120),
  };
}

function contentScore(field: FieldKey, p: Profile): { score: number; reason: string | null } {
  if (!p.n) return { score: 0, reason: null };
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  switch (field) {
    case 'email': return p.email >= 0.3 ? { score: Math.min(1, p.email + 0.1), reason: `${pct(p.email)} of values are email addresses` } : { score: 0, reason: null };
    case 'phone':
    case 'secondaryPhone': return p.phone >= 0.4 ? { score: Math.min(0.95, p.phone), reason: `${pct(p.phone)} of values are valid phone numbers` } : { score: 0, reason: null };
    case 'country': return p.country >= 0.5 ? { score: Math.min(0.95, p.country), reason: `${pct(p.country)} of values are countries` } : { score: 0, reason: null };
    case 'fullName': return p.nameLike >= 0.6 && p.distinct > 0.6 ? { score: 0.55 * p.nameLike, reason: `${pct(p.nameLike)} of values look like personal names` } : { score: 0, reason: null };
    case 'priority': return p.priority >= 0.6 ? { score: 0.7, reason: 'Values look like priorities (hot/warm/cold, high/low…)' } : { score: 0, reason: null };
    case 'score': return p.num0to100 >= 0.8 ? { score: 0.35, reason: 'Numeric values between 0 and 100' } : { score: 0, reason: null };
    case 'tags': return p.multiValue >= 0.3 ? { score: 0.3, reason: 'Comma-separated values' } : { score: 0, reason: null };
    default: return { score: 0, reason: null };
  }
}

/** Header says one thing, values contradict it → reduce confidence (e.g. "Email" column full of phone numbers). */
function contradiction(field: FieldKey, p: Profile) {
  if (!p.n) return 0;
  // Values that are overwhelmingly emails/phones belong to those fields, whatever the header says.
  if (field !== 'email' && p.email >= 0.7) return 0.6;
  if (field !== 'phone' && field !== 'secondaryPhone' && p.phone >= 0.7 && p.email < 0.3) return 0.6;
  if (field === 'email' && p.email < 0.2) return 0.5;
  if ((field === 'phone' || field === 'secondaryPhone') && p.phone < 0.2 && p.email > 0.5) return 0.6;
  if (field === 'score' && p.num0to100 < 0.5) return 0.4;
  return 0;
}

export type ColumnDetection = { field: string; confidence: number; reasons: string[]; sample: string[]; empty: boolean };

export function detectColumns(headers: string[], rows: string[][], defaultCountry = 'US') {
  const fields = Object.keys(SYNONYMS) as FieldKey[];
  const profiles = headers.map((_, i) => profile(rows.map((r) => r[i] ?? ''), defaultCountry));
  const candidates: { col: number; field: FieldKey; conf: number; reasons: string[] }[] = [];
  headers.forEach((h, col) => {
    for (const f of fields) {
      const hs = headerScore(h, f);
      const cs = contentScore(f, profiles[col]);
      let conf = Math.max(hs.score, cs.score * 0.95);
      if (hs.score > 0 && cs.score > 0) conf = Math.min(1, Math.max(hs.score, cs.score) + 0.15);
      if (hs.score > 0) conf -= contradiction(f, profiles[col]);
      const reasons = [hs.reason, cs.reason].filter(Boolean) as string[];
      if (conf >= 0.3) candidates.push({ col, field: f, conf: Math.max(0, Math.min(1, conf)), reasons });
    }
  });
  candidates.sort((a, b) => b.conf - a.conf);
  const usedField = new Set<string>();
  const assigned = new Map<number, { field: string; conf: number; reasons: string[] }>();
  for (const c of candidates) {
    if (assigned.has(c.col) || c.conf < 0.45) continue;
    let field: FieldKey = c.field;
    // A second phone-like column becomes the secondary phone.
    if (field === 'phone' && usedField.has('phone') && !usedField.has('secondaryPhone')) field = 'secondaryPhone';
    if (usedField.has(field)) continue;
    // Prefer explicit first/last name columns over a weak full-name guess.
    if (field === 'fullName' && (usedField.has('firstName') || usedField.has('lastName')) && c.conf < 0.9) continue;
    assigned.set(c.col, { field, conf: c.conf, reasons: c.reasons });
    usedField.add(field);
  }
  const details: Record<string, ColumnDetection> = {};
  const mapping: Record<string, string> = {};
  headers.forEach((h, col) => {
    const p = profiles[col];
    const sample = rows.map((r) => (r[col] ?? '').trim()).filter(Boolean).slice(0, 4);
    const a = assigned.get(col);
    if (a) {
      mapping[h] = a.field;
      details[h] = { field: a.field, confidence: Math.round(a.conf * 100) / 100, reasons: a.reasons, sample, empty: false };
    } else if (p.n === 0) {
      mapping[h] = 'ignore';
      details[h] = { field: 'ignore', confidence: 1, reasons: ['Column is empty'], sample, empty: true };
    } else {
      // Keep unknown-but-populated columns as custom fields rather than discarding data.
      const key = norm(h).replace(/ /g, '_').replace(/^[^a-z]+/, '').slice(0, 40) || `column_${col + 1}`;
      mapping[h] = `custom:${key}`;
      details[h] = { field: `custom:${key}`, confidence: 0.4, reasons: [p.url > 0.5 ? 'Looks like URLs — kept as a custom field' : 'No standard field matched — kept as a custom field'], sample, empty: false };
    }
  });
  return { mapping, details };
}

// ── File structure ─────────────────────────────────────────────────

/** Picks the delimiter that splits the first lines most consistently. */
export function detectDelimiter(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 25);
  const cands = [',', ';', '\t', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of cands) {
    const counts = lines.map((l) => {
      let n = 0;
      let q = false;
      for (const ch of l) {
        if (ch === '"') q = !q;
        else if (ch === d && !q) n++;
      }
      return n;
    });
    if (!counts.length || Math.max(...counts) === 0) continue;
    const freq = new Map<number, number>();
    counts.forEach((c) => freq.set(c, (freq.get(c) ?? 0) + 1));
    const [mode, modeCount] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    const score = mode > 0 ? (modeCount / counts.length) * 10 + Math.min(mode, 30) / 10 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Finds the header row among the first rows (files often start with titles, notes or blank lines). Returns 1-based index, or 0 if there is no header. */
export function detectHeaderRow(rows: string[][]) {
  const top = rows.slice(0, 12);
  const width = Math.max(1, ...top.map((r) => r.filter((c) => c.trim()).length));
  let best = { idx: 1, score: -Infinity, headerHits: 0, dataHits: 0 };
  top.forEach((r, i) => {
    const cells = r.map((c) => c.trim()).filter(Boolean);
    if (cells.length < Math.max(2, Math.ceil(width * 0.5))) return;
    let headerHits = 0, textLike = 0, dataHits = 0;
    for (const c of cells) {
      const n = norm(c);
      if ((Object.values(SYNONYMS) as string[][]).some((syns) => syns.includes(n))) headerHits++;
      if (EMAIL_RE.test(c) || /^\+?[\d\s().-]{7,}$/.test(c) || /^\d+([.,]\d+)?$/.test(c)) dataHits++;
      else if (c.length <= 40) textLike++;
    }
    const score = headerHits * 3 + textLike - dataHits * 2 - i * 0.2;
    if (score > best.score) best = { idx: i + 1, score, headerHits, dataHits };
  });
  // If the best candidate is clearly data (emails/phones, no header words) there is no header row.
  if (best.headerHits === 0 && best.dataHits > 0) return 0;
  return best.idx;
}

/** Converts arbitrary-encoding CSV bytes to UTF-8 (UTF-8 with/without BOM, UTF-16 LE/BE, otherwise Windows-1252). */
export function toUtf8(buf: Buffer): { text: string; encoding: string } {
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16LE' };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'UTF-16BE' };
  // UTF-16 without BOM: lots of NUL bytes in alternating positions.
  const head = buf.subarray(0, 2000);
  let oddNul = 0, evenNul = 0;
  for (let i = 0; i < head.length; i++) if (head[i] === 0) (i % 2 ? oddNul++ : evenNul++);
  if (oddNul > head.length / 4) return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'UTF-16LE' };
  if (evenNul > head.length / 4) return { text: new TextDecoder('utf-16be').decode(buf), encoding: 'UTF-16BE' };
  const start = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(start)), encoding: start ? 'UTF-8 (BOM)' : 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'Windows-1252' };
  }
}
