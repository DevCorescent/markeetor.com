import { nameSimilarity } from './registry';

/**
 * Wikidata (free, open API — Wikimedia asks for a descriptive User-Agent): official website, industry,
 * founding year, headquarters, employee count and country for companies notable enough to have an entry.
 * Accepted only for a close name match whose description says it is a business.
 */

export type WikidataFacts = { id: string; label: string; description: string | null; website: string | null; industry: string | null; foundedYear: number | null; headquarters: string | null; country: string | null; employees: number | null; url: string };

const UA = `LeadsCRM-Enrichment/1.0 (${process.env.APP_URL ?? 'https://localhost'}; company research)`;
const BUSINESS = /\b(company|business|enterprise|corporation|firm|manufacturer|brand|bank|startup|conglomerate|retailer|agency|group|provider|developer|publisher|airline|hospital|clinic|insurer|exporter|maker|marketplace|website|platform|service)\b/i;

async function api(params: Record<string, string>) {
  const res = await fetch(`https://www.wikidata.org/w/api.php?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`, { headers: { 'User-Agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

type Claim = { mainsnak?: { datavalue?: { value?: unknown } } };
const first = (claims: Record<string, Claim[]> | undefined, p: string) => claims?.[p]?.[0]?.mainsnak?.datavalue?.value;

export async function wikidataLookup(name: string): Promise<WikidataFacts | null> {
  const search = (await api({ action: 'wbsearchentities', search: name, language: 'en', type: 'item', limit: '5' })) as { search?: { id: string; label: string; description?: string }[] };
  const hit = (search.search ?? []).find((s) => nameSimilarity(name, s.label) >= 0.85 && BUSINESS.test(s.description ?? ''));
  if (!hit) return null;
  const ent = ((await api({ action: 'wbgetentities', ids: hit.id, props: 'claims|descriptions|labels', languages: 'en' })) as { entities?: Record<string, { claims?: Record<string, Claim[]> }> }).entities?.[hit.id];
  const c = ent?.claims;
  const itemId = (p: string) => (first(c, p) as { id?: string } | undefined)?.id ?? null;
  const ids = [itemId('P452'), itemId('P159'), itemId('P17')].filter((x): x is string => Boolean(x));
  const labels = ids.length ? (((await api({ action: 'wbgetentities', ids: ids.join('|'), props: 'labels', languages: 'en' })) as { entities?: Record<string, { labels?: { en?: { value: string } } }> }).entities ?? {}) : {};
  const label = (id: string | null) => (id ? labels[id]?.labels?.en?.value ?? null : null);
  const inception = (first(c, 'P571') as { time?: string } | undefined)?.time;
  const employees = Number((first(c, 'P1128') as { amount?: string } | undefined)?.amount ?? NaN);
  const website = first(c, 'P856');
  return {
    id: hit.id, label: hit.label, description: hit.description ?? null,
    website: typeof website === 'string' ? website : null,
    industry: label(itemId('P452')), headquarters: label(itemId('P159')), country: label(itemId('P17')),
    foundedYear: inception ? Number(inception.replace(/^\+/, '').slice(0, 4)) || null : null,
    employees: Number.isFinite(employees) ? Math.abs(employees) : null,
    url: `https://www.wikidata.org/wiki/${hit.id}`,
  };
}
