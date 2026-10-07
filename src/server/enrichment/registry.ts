import type { Prisma } from '@prisma/client';
import { decodeCin, findCins } from '@/lib/company-registry';
import { withPlatform } from '../db';
import { logger } from '../logger';

/**
 * Company registry lookup. Sources, most authoritative first:
 *   1. Falcon eBiz API (MCA master data; `FALCONEBIZ_API_KEY` + `FALCONEBIZ_DOMAIN`) — search by name/CIN, then details by CIN.
 *   2. OpenCorporates API (`OPENCORPORATES_API_TOKEN`) — global registries, India included.
 *   3. The company's own website: a CIN printed on the site, decoded (listing, state, year, company type).
 * Directories that forbid automated access (ZaubaCorp, Tracxn, …) are never fetched; users get links instead.
 * Results are cached per company in `company_registry_records`. Directors and contact details are dropped.
 */

export type Registry = {
  source: 'falconebiz' | 'opencorporates' | 'website-cin' | 'web' | 'manual';
  regId: string | null;
  legalName: string | null;
  status: string | null;
  incorporated: string | null;
  yearIncorporated: number | null;
  type: string | null;
  category: string | null;
  listed: boolean | null;
  roc: string | null;
  state: string | null;
  district: string | null;
  activity: string | null;
  authorisedCapital: number | null;
  paidUpCapital: number | null;
  jurisdiction: string | null;
  url: string | null;
};

const TTL_MS = 60 * 86_400_000;
const LEGAL = /\b(private limited|pvt\.? ?ltd\.?|pvt|limited|ltd\.?|llp|llc|inc\.?|incorporated|corp\.?|corporation|company|co\.?|opc)\b/gi;
export const nameKey = (n: string) => n.toLowerCase().replace(/&/g, ' and ').replace(LEGAL, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/** How closely two company names agree (0–1), ignoring legal suffixes and punctuation. */
export function nameSimilarity(a: string, b: string) {
  const x = nameKey(a), y = nameKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const tx = new Set(x.split(' ')), ty = new Set(y.split(' '));
  const inter = [...tx].filter((t) => ty.has(t)).length;
  const jaccard = inter / new Set([...tx, ...ty]).size;
  const squashed = x.replace(/ /g, '') === y.replace(/ /g, '') ? 1 : 0;
  return Math.max(jaccard, squashed);
}

const empty = (source: Registry['source']): Registry => ({ source, regId: null, legalName: null, status: null, incorporated: null, yearIncorporated: null, type: null, category: null, listed: null, roc: null, state: null, district: null, activity: null, authorisedCapital: null, paidUpCapital: null, jurisdiction: null, url: null });
const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
const str = (v: unknown) => (typeof v === 'string' && v.trim() && !/^AS-PER-THE-RECORDS$/i.test(v.trim()) ? v.trim().slice(0, 200) : null);

// ── Providers ──────────────────────────────────────────────────────

async function falconFetch(path: string, company: string) {
  const key = process.env.FALCONEBIZ_API_KEY;
  if (!key) return null;
  const res = await fetch(`https://www.falconebiz.com/api/${path}`, {
    method: 'GET', signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json', Authorization: key, Company: company, Domain: process.env.FALCONEBIZ_DOMAIN ?? new URL(process.env.APP_URL ?? 'http://localhost').hostname },
  });
  if (!res.ok) throw new Error(`Falcon eBiz ${path}: HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
}

/** Falcon eBiz: name → best-matching CIN (state breaks ties) → master data. */
export async function falconLookup(name: string, opts: { cin?: string | null; state?: string | null }): Promise<Registry | null> {
  if (!process.env.FALCONEBIZ_API_KEY) return null;
  let cin = opts.cin ?? null;
  let legal: string | null = null;
  if (!cin) {
    const list = (await falconFetch('search_company', name)) as { value: string; label: string }[] | null;
    const scored = (Array.isArray(list) ? list : []).map((c) => ({ ...c, score: nameSimilarity(name, c.label) + (opts.state && decodeCin(c.value)?.state?.toLowerCase() === opts.state.toLowerCase() ? 0.05 : 0) }))
      .filter((c) => c.score >= 0.8).sort((a, b) => b.score - a.score);
    if (!scored.length) return null;
    cin = scored[0].value;
    legal = scored[0].label;
  }
  const raw = (await falconFetch('company_details', cin)) as Record<string, unknown> | null;
  const d = ((raw?.company_details ?? (Array.isArray(raw) ? raw[0] : raw)) ?? {}) as Record<string, unknown>;
  const decoded = decodeCin(cin);
  return {
    ...empty('falconebiz'),
    regId: str(d.cin) ?? cin, legalName: str(d.company_name) ?? legal, status: str(d.statusname), incorporated: str(d.incorporation_date),
    yearIncorporated: Number(String(d.incorporation_date ?? '').slice(0, 4)) || decoded?.yearIncorporated || null,
    type: [str(d.class), str(d.subcategory)].filter(Boolean).join(' · ') || decoded?.type || null, category: str(d.category),
    listed: str(d.list_status) ? /^listed/i.test(String(d.list_status)) : decoded?.listed ?? null,
    roc: str(d.roc), state: str(d.state) ?? decoded?.state ?? null, district: str(d.district), activity: str(d.activity)?.replace(/^\(([^)]+)\)\s*/, '') ?? null,
    authorisedCapital: num(d.auth_capital), paidUpCapital: num(d.paid_capital), jurisdiction: 'in',
  };
}

/** OpenCorporates: best name match (same jurisdiction when known). */
export async function openCorporatesLookup(name: string, opts: { jurisdiction?: string | null; regId?: string | null }): Promise<Registry | null> {
  const token = process.env.OPENCORPORATES_API_TOKEN;
  if (!token) return null;
  const q = new URLSearchParams({ q: opts.regId ?? name, api_token: token, per_page: '5', ...(opts.jurisdiction ? { jurisdiction_code: opts.jurisdiction } : {}) });
  const res = await fetch(`https://api.opencorporates.com/v0.4/companies/search?${q}`, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`OpenCorporates: HTTP ${res.status}`);
  const j = (await res.json()) as { results?: { companies?: { company: Record<string, unknown> }[] } };
  const best = (j.results?.companies ?? []).map((c) => c.company).map((c) => ({ c, s: opts.regId && c.company_number === opts.regId ? 1 : nameSimilarity(name, String(c.name ?? '')) }))
    .filter((x) => x.s >= 0.8).sort((a, b) => b.s - a.s)[0]?.c;
  if (!best) return null;
  const addr = (best.registered_address ?? {}) as Record<string, unknown>;
  const regId = str(best.company_number);
  const decoded = regId ? decodeCin(regId) : null;
  return {
    ...empty('opencorporates'),
    regId, legalName: str(best.name), status: str(best.current_status), incorporated: str(best.incorporation_date),
    yearIncorporated: Number(String(best.incorporation_date ?? '').slice(0, 4)) || decoded?.yearIncorporated || null,
    type: str(best.company_type) ?? decoded?.type ?? null, listed: decoded?.listed ?? null,
    state: str(addr.region) ?? decoded?.state ?? null, district: str(addr.locality), jurisdiction: str(best.jurisdiction_code), url: str(best.opencorporates_url),
  };
}

/** A CIN printed on the company's own website, decoded — free and exact, but only basic facts. */
export function websiteCinLookup(siteText: string | null, name: string | null, found: string[] = []): Registry | null {
  const cins = [...new Set([...found, ...(siteText ? findCins(siteText) : [])])];
  if (!cins.length) return null;
  const d = decodeCin(cins[0])!;
  return { ...empty('website-cin'), regId: d.cin, legalName: name, yearIncorporated: d.yearIncorporated, type: d.type, listed: d.listed, state: d.state, jurisdiction: 'in' };
}

// ── Orchestration with cache ───────────────────────────────────────

export async function lookupRegistry(input: { name: string | null; siteText: string | null; siteCins?: string[]; region: string | null; state: string | null }): Promise<Registry | null> {
  const fromSite = websiteCinLookup(input.siteText, input.name, input.siteCins);
  const cin = fromSite?.regId ?? null;
  const key = input.name ? nameKey(input.name) : null;
  // Cache: by CIN first, then by name.
  const cached = await withPlatform((tx) => tx.companyRegistryRecord.findFirst({ where: cin ? { regId: cin } : key ? { nameKey: key } : { id: '__none__' }, orderBy: { fetchedAt: 'desc' } }));
  if (cached && Date.now() - cached.fetchedAt.getTime() < TTL_MS) return cached.data as unknown as Registry;
  const india = input.region === 'IN' || Boolean(cin);
  let rec: Registry | null = null;
  try {
    if (india && (cin || input.name)) rec = await falconLookup(input.name ?? cin!, { cin, state: input.state });
  } catch (err) { logger.warn({ err }, 'registry: Falcon eBiz lookup failed'); }
  try {
    if (!rec && (cin || input.name)) rec = await openCorporatesLookup(input.name ?? cin!, { jurisdiction: india ? 'in' : null, regId: cin });
  } catch (err) { logger.warn({ err }, 'registry: OpenCorporates lookup failed'); }
  rec ??= fromSite;
  if (!rec) return null;
  const save = { regId: rec.regId, nameKey: nameKey(rec.legalName ?? input.name ?? rec.regId ?? ''), source: rec.source, data: rec as unknown as Prisma.InputJsonValue, fetchedAt: new Date() };
  await withPlatform((tx) => (rec!.regId
    ? tx.companyRegistryRecord.upsert({ where: { regId: rec!.regId }, create: save, update: save })
    : tx.companyRegistryRecord.create({ data: save }))).catch(() => null);
  return rec;
}

export const registryConfigured = () => ({ falconebiz: Boolean(process.env.FALCONEBIZ_API_KEY), opencorporates: Boolean(process.env.OPENCORPORATES_API_TOKEN) });
