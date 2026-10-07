/**
 * Indian company identifiers and "check this company" links — shared by server and UI.
 *
 * CIN (Corporate Identification Number), e.g. U72200KA2015PTC082947:
 *   U/L listing · 5-digit industry code · 2-letter state · year of incorporation · ownership type · registration no.
 * LLPIN, e.g. AAB-1234.
 */

export const CIN_RE = /\b([LU])(\d{5})([A-Z]{2})(\d{4})([A-Z]{3})(\d{6})\b/g;
export const LLPIN_RE = /\b([A-Z]{3}-\d{4})\b/g;

const STATES: Record<string, string> = {
  AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar', CT: 'Chhattisgarh', CG: 'Chhattisgarh', GA: 'Goa', GJ: 'Gujarat', HR: 'Haryana', HP: 'Himachal Pradesh',
  JK: 'Jammu and Kashmir', JH: 'Jharkhand', KA: 'Karnataka', KL: 'Kerala', MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur', ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland',
  OR: 'Odisha', OD: 'Odisha', PB: 'Punjab', RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TG: 'Telangana', TS: 'Telangana', TR: 'Tripura', UP: 'Uttar Pradesh', UR: 'Uttarakhand',
  UK: 'Uttarakhand', WB: 'West Bengal', DL: 'Delhi', CH: 'Chandigarh', PY: 'Puducherry', AN: 'Andaman and Nicobar Islands', DN: 'Dadra and Nagar Haveli', DD: 'Daman and Diu', LD: 'Lakshadweep', LA: 'Ladakh',
};
const OWNERSHIP: Record<string, string> = {
  PTC: 'Private limited company', PLC: 'Public limited company', OPC: 'One person company', FTC: 'Subsidiary of a foreign company', GOI: 'Government of India company',
  SGC: 'State government company', NPL: 'Not-for-profit (Section 8) company', ULL: 'Public unlimited company', ULT: 'Private unlimited company', GAP: 'Public company limited by guarantee',
  GAT: 'Private company limited by guarantee', FLC: 'Financial lease company',
};

export type CinFacts = { cin: string; listed: boolean; industryCode: string; state: string | null; stateCode: string; yearIncorporated: number; type: string | null; ownershipCode: string };

export const isLlpin = (v: string) => /^[A-Z]{3}-\d{4}$/.test(v.trim().toUpperCase());

export function decodeCin(cin: string): CinFacts | null {
  const m = new RegExp(CIN_RE.source).exec(cin.toUpperCase());
  if (!m) return null;
  const year = Number(m[4]);
  if (year < 1850 || year > new Date().getFullYear()) return null;
  return { cin: m[0], listed: m[1] === 'L', industryCode: m[2], stateCode: m[3], state: STATES[m[3]] ?? null, yearIncorporated: year, ownershipCode: m[5], type: OWNERSHIP[m[5]] ?? null };
}

/** CINs printed on a page (footers often carry them). */
export function findCins(text: string) {
  return [...new Set([...text.toUpperCase().matchAll(CIN_RE)].map((m) => m[0]))].filter((c) => decodeCin(c)).slice(0, 5);
}

export type CompanyLink = { key: string; label: string; url: string; hint: string; direct: boolean };

const enc = encodeURIComponent;
/** "Info Edge (India) Ltd." → "INFO-EDGE-INDIA-LTD" (ZaubaCorp search path). */
const zaubaSlug = (n: string) => n.toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** "Delcore Healthcare Private Limited" → "Delcore Healthcare" — directory searches match on the core name. */
export const coreName = (n: string) => n.replace(/\b(private limited|pvt\.?\s*ltd\.?|pvt|limited|ltd\.?|llp|l\.l\.p\.?|llc|inc\.?|incorporated|corp\.?|corporation|opc)\b\.?/gi, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim() || n;
const slug = (n: string) => n.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'company';

/**
 * One-click checks on company directories. Every URL pattern below was verified against the live sites:
 *  - with a CIN, ZaubaCorp / Falcon eBiz / Tofler / The Company Check / OpenCorporates open the exact company page
 *    (each resolves the page by CIN);
 *  - without one, only sites with a real name search are linked (ZaubaCorp, OpenCorporates, Tracxn after sign-in,
 *    Crunchbase, LinkedIn, Google) — ZaubaCorp’s results list each company’s CIN.
 */
export function companyLinks(name: string, opts: { cin?: string | null; india?: boolean } = {}): CompanyLink[] {
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const core = coreName(clean);
  // A CIN, or an LLPIN for LLPs (e.g. AAA-4095) — ZaubaCorp, Tofler, The Company Check and OpenCorporates resolve both.
  const id = opts.cin ? opts.cin.trim().toUpperCase() : null;
  const isCin = Boolean(id && decodeCin(id));
  const cin = id && (isCin || isLlpin(id)) ? id : null;
  const india = opts.india ?? Boolean(cin);
  const links: CompanyLink[] = [];
  if (india) {
    links.push({ key: 'zaubacorp', label: 'ZaubaCorp', direct: Boolean(cin), url: `https://www.zaubacorp.com/companysearchresults/${cin ?? zaubaSlug(core)}`, hint: cin ? 'Company page: registration, status and filings' : 'Search by name — results show each company’s CIN' });
    if (cin) {
      links.push(
        ...(isCin ? [{ key: 'falconebiz', label: 'Falcon eBiz', direct: true, url: `https://www.falconebiz.com/company/${zaubaSlug(clean)}-${cin}`, hint: 'MCA master data' }] : []),
        { key: 'tofler', label: 'Tofler', direct: true, url: `https://www.tofler.in/${slug(clean)}/company/${cin}`, hint: 'Financial summary' },
        { key: 'thecompanycheck', label: 'The Company Check', direct: true, url: `https://www.thecompanycheck.com/company/${slug(clean)}/${cin}`, hint: 'Financials and compliance' },
        { key: 'mca', label: 'MCA (official)', direct: false, url: 'https://www.mca.gov.in/content/mca/global/en/mca/master-data/MDS.html', hint: `Paste ${isCin ? 'CIN' : 'LLPIN'} ${cin} on the MCA master data page` },
      );
    }
  }
  links.push(
    { key: 'opencorporates', label: 'OpenCorporates', direct: Boolean(cin), url: cin ? `https://opencorporates.com/companies/in/${cin}` : `https://opencorporates.com/companies${india ? '/in' : ''}?q=${enc(core)}`, hint: 'Registry records' },
    { key: 'tracxn', label: 'Tracxn', direct: false, url: `https://tracxn.com/a/s/query/t/companies?q=${enc(core)}`, hint: 'Funding and competitors (opens after you sign in to Tracxn)' },
    { key: 'crunchbase', label: 'Crunchbase', direct: false, url: `https://www.crunchbase.com/textsearch?q=${enc(core)}`, hint: 'Funding and overview' },
    { key: 'linkedin', label: 'LinkedIn', direct: false, url: `https://www.linkedin.com/search/results/companies/?keywords=${enc(core)}`, hint: 'Company page' },
    { key: 'google', label: 'Google', direct: false, url: `https://www.google.com/search?q=${enc(`"${clean}"${india ? ' company' : ''}`)}`, hint: 'Everything else' },
  );
  return links;
}
