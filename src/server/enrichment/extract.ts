import { findCins } from '@/lib/company-registry';

/**
 * Deterministic extraction from public company web pages: structured data (JSON-LD), meta tags, social
 * profiles, generic contact points and readable text. No third-party parser — pages are untrusted input,
 * so everything here is bounded and regex-based.
 */

export type PageFacts = {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  org: { name?: string; description?: string; telephone?: string; email?: string; foundingDate?: string; employees?: string; address?: { city?: string; region?: string; country?: string; street?: string; postal?: string }; sameAs?: string[]; industry?: string; logo?: string } | null;
  socials: Record<string, string>;
  emails: string[];
  phones: string[];
  links: string[];
  /** Company registration numbers (CIN) found anywhere on the page — footers usually carry them. */
  cins?: string[];
  text: string;
};

const decode = (s: string) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x10ffff ? String.fromCodePoint(c) : ''; })
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => { const c = parseInt(n, 16); return c > 0 && c < 0x10ffff ? String.fromCodePoint(c) : ''; });
const clean = (s: string | null | undefined, max = 400) => (s ? decode(s).replace(/\s+/g, ' ').trim().slice(0, max) || null : null);

function meta(html: string, key: string) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  return tag ? clean(/content=["']([^"']*)["']/i.exec(tag)?.[1]) : null;
}

const ORG_TYPES = /Organization|Corporation|LocalBusiness|Company|Store|Agency|Brokerage|Service|Professional|Insurance|RealEstate|Medical|Legal|Financial|Restaurant|Hotel|School|Automotive|Contractor|Business|Firm|Office|Clinic|Dealer|Practice|Dentist|Attorney|Plumber|Electrician/i;

function jsonLdOrg(html: string): PageFacts['org'] {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].slice(0, 10);
  for (const b of blocks) {
    let doc: unknown;
    try { doc = JSON.parse(b[1].trim()); } catch { continue; }
    const items: Record<string, unknown>[] = [];
    const walk = (x: unknown, depth = 0) => {
      if (!x || depth > 4) return;
      if (Array.isArray(x)) return x.slice(0, 30).forEach((y) => walk(y, depth + 1));
      if (typeof x === 'object') {
        const o = x as Record<string, unknown>;
        items.push(o);
        if (o['@graph']) walk(o['@graph'], depth + 1);
      }
    };
    walk(doc);
    const org = items.find((o) => ORG_TYPES.test(String(o['@type'] ?? '')) && o.name)
      ?? items.find((o) => o.name && (o.address || o.telephone) && !/Person|WebPage|WebSite|Article|BreadcrumbList|Product/i.test(String(o['@type'] ?? '')));
    if (!org) continue;
    const s = (v: unknown) => (typeof v === 'string' ? clean(v, 300) ?? undefined : typeof v === 'number' ? String(v) : undefined);
    const addr = (Array.isArray(org.address) ? org.address[0] : org.address) as Record<string, unknown> | undefined;
    const emp = org.numberOfEmployees as Record<string, unknown> | string | number | undefined;
    return {
      name: s(org.name), description: s(org.description), telephone: s(org.telephone), email: s(org.email), foundingDate: s(org.foundingDate),
      employees: typeof emp === 'object' && emp ? s(emp.value ?? (emp.minValue != null ? `${emp.minValue}-${emp.maxValue ?? ''}` : undefined)) : s(emp),
      address: addr && typeof addr === 'object' ? { street: s(addr.streetAddress), city: s(addr.addressLocality), region: s(addr.addressRegion), country: s(typeof addr.addressCountry === 'object' ? (addr.addressCountry as Record<string, unknown>)?.name : addr.addressCountry), postal: s(addr.postalCode) } : undefined,
      sameAs: (Array.isArray(org.sameAs) ? org.sameAs : org.sameAs ? [org.sameAs] : []).filter((x): x is string => typeof x === 'string').slice(0, 15),
      industry: s(org.industry), logo: s(typeof org.logo === 'object' ? (org.logo as Record<string, unknown>)?.url : org.logo),
    };
  }
  return null;
}

const SOCIAL: [string, RegExp][] = [
  ['linkedin', /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[^/?#\s"']+/i],
  ['x', /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!share|intent|home)[A-Za-z0-9_]{2,30}\/?$/i],
  ['facebook', /^https?:\/\/(?:www\.)?facebook\.com\/(?!sharer|share|dialog|plugins)[^/?#\s"']+\/?$/i],
  ['instagram', /^https?:\/\/(?:www\.)?instagram\.com\/[^/?#\s"']+\/?$/i],
  ['youtube', /^https?:\/\/(?:www\.)?youtube\.com\/(?:c\/|channel\/|@)[^/?#\s"']+/i],
];

export function extractPage(html: string, url: string, domain: string): PageFacts {
  const h = html.slice(0, 1_500_000);
  const hrefs = [...h.matchAll(/href=["']([^"'#][^"']*)["']/gi)].map((m) => decode(m[1])).slice(0, 2000);
  const abs = hrefs.map((x) => { try { return new URL(x, url).toString(); } catch { return null; } }).filter(Boolean) as string[];
  const socials: Record<string, string> = {};
  for (const l of abs) for (const [k, re] of SOCIAL) if (!socials[k] && re.test(l)) socials[k] = l.replace(/\/$/, '');
  const emails = [...new Set([
    ...hrefs.filter((x) => /^mailto:/i.test(x)).map((x) => x.slice(7).split('?')[0].toLowerCase()),
    ...[...h.matchAll(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi)].map((m) => m[0].toLowerCase()),
  ])].filter((e) => e.endsWith(`@${domain}`) || e.endsWith(`.${domain}`)).filter((e) => !/\.(png|jpe?g|gif|svg|webp)$/.test(e)).slice(0, 10);
  const phones = [...new Set(hrefs.filter((x) => /^tel:/i.test(x)).map((x) => x.slice(4).replace(/[^\d+]/g, '')).filter((x) => x.replace(/\D/g, '').length >= 7))].slice(0, 6);
  const sameHost = abs.filter((l) => { try { const u = new URL(l); return u.hostname.replace(/^www\./, '') === domain; } catch { return false; } });
  const text = decode(h
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|section|article|br|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 6000);
  return {
    url,
    title: clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h)?.[1], 200),
    description: meta(h, 'description') ?? meta(h, 'og:description'),
    siteName: meta(h, 'og:site_name') ?? meta(h, 'application-name'),
    org: jsonLdOrg(h),
    socials, emails, phones,
    links: [...new Set(sameHost)].slice(0, 300),
    cins: findCins(decode(h.replace(/<[^>]+>/g, ' '))),
    text,
  };
}

/** Pages worth reading after the homepage: about, company, contact, services. */
export function pickPages(links: string[], origin: string) {
  const score = (l: string) => {
    const p = new URL(l).pathname.toLowerCase();
    if (p === '/' || /\.(pdf|jpe?g|png|zip|docx?)$/.test(p) || p.split('/').length > 4) return 0;
    if (/about|who-we-are|our-story|company|overview/.test(p)) return 3;
    if (/contact|locations?|offices?/.test(p)) return 2;
    if (/services|solutions|what-we-do|industries|products/.test(p)) return 1;
    return 0;
  };
  const ranked = [...new Set(links)].map((l) => ({ l, s: score(l) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.l);
  const fallback = [`${origin}/about`, `${origin}/contact`];
  return [...new Set([...ranked, ...fallback])].slice(0, 3);
}

// ── Heuristics (used when AI is off, and to cross-check AI) ─────────

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  'Real Estate': ['real estate', 'realty', 'realtor', 'brokerage', 'properties', 'homes for sale', 'property management', 'mortgage broker', 'apartments', 'listings'],
  Insurance: ['insurance', 'insurer', 'underwriting', 'policyholder', 'coverage', 'claims', 'life insurance', 'auto insurance'],
  'Financial Services': ['financial advisor', 'wealth management', 'investment', 'accounting', 'bookkeeping', 'tax services', 'lending', 'loans', 'bank', 'fintech', 'cpa'],
  'Solar & Energy': ['solar', 'renewable', 'photovoltaic', 'energy efficiency', 'battery storage', 'ev charging', 'utilities'],
  Healthcare: ['clinic', 'healthcare', 'medical', 'dental', 'hospital', 'patients', 'physician', 'pharmacy', 'therapy', 'wellness'],
  Education: ['school', 'university', 'college', 'academy', 'courses', 'students', 'tutoring', 'e-learning', 'training'],
  Automotive: ['dealership', 'automotive', 'car dealer', 'auto repair', 'vehicles', 'collision', 'used cars'],
  Technology: ['software', 'saas', 'cloud computing', 'it services', 'web development', 'app development', 'hr technology', 'hrms', 'erp', 'cybersecurity', 'developers', 'api', 'artificial intelligence', 'data analytics'],
  Legal: ['law firm', 'attorney', 'lawyers', 'legal services', 'litigation', 'paralegal'],
  Marketing: ['marketing agency', 'digital marketing', 'seo', 'advertising', 'branding', 'social media marketing', 'pr agency'],
  Construction: ['construction', 'contractor', 'roofing', 'remodeling', 'builders', 'hvac', 'plumbing', 'electrical contractor'],
  Hospitality: ['hotel', 'restaurant', 'catering', 'resort', 'hospitality', 'travel agency'],
  Retail: ['retail', 'ecommerce', 'online store', 'shop now', 'boutique'],
  Manufacturing: ['manufacturing', 'manufacturer', 'factory', 'industrial', 'fabrication', 'machining'],
  Logistics: ['logistics', 'freight', 'shipping', 'warehousing', 'trucking', 'supply chain', 'courier'],
  'Wedding & Matrimony': ['matrimony', 'matrimonial', 'marriage bureau', 'wedding', 'bride', 'groom', 'life partner', 'match making', 'matchmaking'],
  'Fashion & Apparel': ['embroidery', 'apparel', 'garments', 'clothing', 'fashion', 'textile', 'couture', 'ethnic wear', 'fabrics'],
  'Beauty & Personal Care': ['skin care', 'skincare', 'dermatology', 'dermatologist', 'cosmetic', 'salon', 'beauty', 'hair treatment', 'aesthetic clinic'],
  'Jewellery': ['jewellery', 'jewelry', 'gold', 'diamond', 'silver ornaments', 'bridal jewellery'],
  Consulting: ['consulting', 'consultancy', 'advisory', 'management consulting', 'business consulting'],
};

/** Best-matching industry by keyword density; prefers names already used in the catalog. */
export function classifyIndustry(text: string, catalog: string[]): { industry: string; confidence: number; hits: string[] } | null {
  const t = ` ${text.toLowerCase()} `;
  const scores = Object.entries(INDUSTRY_KEYWORDS).map(([ind, kws]) => {
    const hits = kws.filter((k) => t.includes(` ${k}`) || t.includes(`${k} `));
    const count = kws.reduce((n, k) => n + Math.min(5, t.split(k).length - 1), 0);
    return { ind, hits, count };
  }).filter((x) => x.count > 0).sort((a, b) => b.count - a.count);
  if (!scores.length) return null;
  const [best, second] = scores;
  const margin = second ? best.count / (best.count + second.count) : 1;
  const confidence = Math.round(Math.min(90, 35 + best.hits.length * 10 + margin * 25));
  const canon = catalog.find((c) => c.toLowerCase() === best.ind.toLowerCase() || c.toLowerCase().includes(best.ind.toLowerCase().split(' ')[0])) ?? best.ind;
  return confidence >= 45 ? { industry: canon, confidence, hits: best.hits } : null;
}

export function companyFromTitle(title: string | null, domain: string) {
  if (!title) return null;
  const noise = /^(home|homepage|welcome( to .*)?|official (site|website)|index|about( us)?|contact( us)?)$/i;
  const parts = title.split(/\s[|\-–—:·•]\s/).map((p) => p.trim()).filter((p) => p && !noise.test(p));
  if (!parts.length) return null;
  const stem = domain.split('.')[0].replace(/[-_]/g, '').toLowerCase();
  const match = parts.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, '').includes(stem.slice(0, Math.max(4, stem.length - 2))));
  // Otherwise the most brand-like part: the one with the fewest words (taglines are longer).
  const brand = [...parts].sort((a, b) => a.split(/\s+/).length - b.split(/\s+/).length)[0];
  return (match ?? brand).slice(0, 120);
}

export function sizeBucket(raw: string | undefined | null) {
  if (!raw) return null;
  const n = Number(String(raw).replace(/[^\d].*$/, ''));
  if (!n) return null;
  return n <= 10 ? '1-10' : n <= 50 ? '11-50' : n <= 200 ? '51-200' : n <= 500 ? '201-500' : n <= 1000 ? '501-1000' : n <= 5000 ? '1001-5000' : '5000+';
}
