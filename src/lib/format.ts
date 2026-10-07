import { formatDistanceToNowStrict, format } from 'date-fns';

export const fmtInt = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(n));
export const fmtPct = (n: number | null | undefined, digits = 1) => (n == null || Number.isNaN(n) ? '—' : `${(n * 100).toFixed(digits)}%`);
export const fmtMoney = (n: number | string | null | undefined, currency = 'USD') =>
  n == null || n === '' ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(n));
export const fmtCompact = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n));

export function fmtDate(d: string | Date | null | undefined, pattern = 'MMM d, yyyy') {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? '—' : format(date, pattern);
}
export const fmtDateTime = (d: string | Date | null | undefined) => fmtDate(d, 'MMM d, yyyy · HH:mm');
export function fmtAgo(d: string | Date | null | undefined) {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return `${formatDistanceToNowStrict(date)} ago`;
}
export const humanize = (s: string | null | undefined) =>
  !s ? '—' : s.replace(/[._]/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
