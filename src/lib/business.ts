/** Business-style names ("… Pvt Ltd", "… Clinic"), used to tell a company name from a person's name. */
const BUSINESS_NAME = /\b(private limited|pvt\.? ?ltd|ltd|limited|llc|l\.l\.c|inc|incorporated|corp|corporation|co\.|company|plc|gmbh|llp|lp|enterprises?|solutions|services|technologies|technology|industries|consultants?|consulting|associates|group|holdings|realty|properties|agency|studios?|traders|exports?|motors|clinic|hospital|academy|institute|matrimonials?)\b/i;
export const looksLikeBusiness = (name: string | null | undefined) => Boolean(name && BUSINESS_NAME.test(name));

const SEP = /\s[|\-–—:·•]\s/;
const NOISE = /^(home|homepage|welcome( to)?|official (site|website)|index)\b[\s:|-]*/i;

/**
 * A clean, display-ready company name from whatever research found: never a web address, never a whole
 * page title ("Acme Clinic - Best Eye Hospital in Mumbai | Lasik" → "Acme Clinic").
 */
export function cleanCompanyName(raw: string | null | undefined, domain?: string | null): string | null {
  if (!raw) return null;
  let n = raw.replace(/\s+/g, ' ').trim().replace(NOISE, '');
  // A bare domain ("skinpsyche.com") becomes a name ("Skinpsyche").
  if (/^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/?$/i.test(n)) n = n.replace(/^(https?:\/\/)?(www\.)?/i, '').split('.')[0].replace(/[-_]+/g, ' ');
  if (SEP.test(n) || n.length > 48) {
    const parts = n.split(SEP).map((p) => p.trim().replace(NOISE, '')).filter((p) => p.length >= 2);
    const stem = (domain ?? '').replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    n = (stem.length >= 4 ? parts.find((p) => key(p).includes(stem.slice(0, Math.max(4, stem.length - 3))) || stem.includes(key(p))) : undefined) ?? parts.sort((a, b) => a.length - b.length)[0] ?? n;
  }
  n = n.replace(/[|,;:\s-]+$/, '').trim();
  if (n && n === n.toLowerCase()) n = n.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  if (n.length < 2 || /^[a-z0-9-]+\.[a-z]{2,}$/i.test(n)) return null;
  return n.slice(0, 80);
}
