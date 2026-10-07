import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type Normalized = { value: string | null; error?: string };

export function normalizeEmail(raw: unknown): Normalized {
  if (raw === null || raw === undefined) return { value: null };
  const v = String(raw).trim().toLowerCase().replace(/^mailto:/, '');
  if (!v) return { value: null };
  if (v.length > 254 || !EMAIL_RE.test(v)) return { value: null, error: 'Invalid email address' };
  return { value: v };
}

export function normalizePhone(raw: unknown, defaultCountry = 'US'): Normalized {
  if (raw === null || raw === undefined) return { value: null };
  let v = String(raw).trim();
  if (!v) return { value: null };
  // Spreadsheets often turn phone numbers into floats ("9.198e+11") or prefix them with a quote.
  v = v.replace(/^'/, '');
  if (/^\d+(\.\d+)?e\+\d+$/i.test(v)) v = Number(v).toFixed(0);
  if (/^00\d/.test(v)) v = `+${v.slice(2)}`;
  const region = isSupportedCountry(defaultCountry) ? (defaultCountry as CountryCode) : 'US';
  const parsed = parsePhoneNumberFromString(v, region);
  if (!parsed || !parsed.isPossible()) return { value: null, error: 'Invalid phone number' };
  return { value: parsed.number };
}

export function cleanText(raw: unknown, max = 200): string | null {
  if (raw === null || raw === undefined) return null;
  // Strip control characters; collapse whitespace.
  const v = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, max) : null;
}

export function titleCaseName(raw: string): string {
  if (raw !== raw.toUpperCase() && raw !== raw.toLowerCase()) return raw;
  return raw.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** Neutralises spreadsheet formula injection in generated CSV/XLSX cells (OWASP CSV injection guidance). */
export function safeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function toCsv(rows: unknown[][]): string {
  return rows
    .map((r) => r.map((c) => {
      const s = safeCell(c);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\r\n');
}
