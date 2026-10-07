import { z } from 'zod';

/** Seller details and tax rules for invoices, and online payments (Admin → Finance). Shared by server and UI. */

/** Indian GST state codes (first two digits of a GSTIN). */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const stateFromGstin = (g: string | null | undefined) => (g && GSTIN_RE.test(g) ? GST_STATES[g.slice(0, 2)] ?? null : null);

export const financeSettingsSchema = z.object({
  seller: z.object({
    legalName: z.string().trim().max(160).default(''),
    gstin: z.string().trim().toUpperCase().max(15).refine((v) => !v || GSTIN_RE.test(v), 'Enter a valid 15-character GSTIN').default(''),
    pan: z.string().trim().toUpperCase().max(10).default(''),
    address: z.string().trim().max(400).default(''),
    state: z.string().trim().max(60).default(''),
    email: z.string().trim().max(254).default(''),
    phone: z.string().trim().max(40).default(''),
  }).default({ legalName: '', gstin: '', pan: '', address: '', state: '', email: '', phone: '' }),
  invoices: z.object({
    enabled: z.boolean().default(true),
    prefix: z.string().trim().regex(/^[A-Z0-9-]{1,10}$/).default('INV'),
    /** SAC code for the service (998399 = other professional/technical services; 998371 = data/info services). */
    sac: z.string().trim().max(8).default('998399'),
    /** Financial year starts in April (India). */
    fyStartMonth: z.number().int().min(1).max(12).default(4),
    terms: z.string().trim().max(600).default('Payment due within 15 days. This is a computer-generated invoice.'),
  }).default({ enabled: true, prefix: 'INV', sac: '998399', fyStartMonth: 4, terms: 'Payment due within 15 days. This is a computer-generated invoice.' }),
  payments: z.object({
    /** Razorpay checkout for credit purchases (needs RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET). */
    razorpay: z.boolean().default(true),
  }).default({ razorpay: true }),
});
export type FinanceSettings = z.infer<typeof financeSettingsSchema>;
export const DEFAULT_FINANCE: FinanceSettings = financeSettingsSchema.parse({});

/** Financial-year label for a date, e.g. 2026-27 when the year starts in April. */
export function financialYear(d: Date, startMonth = 4) {
  const y = d.getMonth() + 1 >= startMonth ? d.getFullYear() : d.getFullYear() - 1;
  return startMonth === 1 ? String(y) : `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/** GST split: same state → CGST + SGST (half each); otherwise IGST. Amounts in paise/cents. */
export function gstSplit(taxCents: number, sellerState: string, buyerState: string | null) {
  const intra = Boolean(sellerState && buyerState && sellerState.trim().toLowerCase() === buyerState.trim().toLowerCase());
  if (!intra) return { cgst: 0, sgst: 0, igst: taxCents };
  const half = Math.floor(taxCents / 2);
  return { cgst: half, sgst: taxCents - half, igst: 0 };
}

// ── Alert rules ────────────────────────────────────────────────────

export const ALERT_METRICS = [
  { key: 'client_credits_below', label: 'A client’s credit balance falls below', unit: 'credits', hint: 'Fires per client (only clients that have bought credits).' },
  { key: 'stock_below', label: 'Available stock falls below', unit: 'leads', hint: 'Optionally for one industry.', param: 'industry' },
  { key: 'pending_request_hours', label: 'A lead request has waited longer than', unit: 'hours' },
  { key: 'pending_credit_hours', label: 'A credit request has waited longer than', unit: 'hours' },
  { key: 'supplier_report_rate', label: 'A supplier’s quality-report rate exceeds', unit: '%', hint: 'Last 30 days, suppliers with at least 10 sold leads.' },
  { key: 'client_health_below', label: 'A client’s health score falls below', unit: 'score' },
  { key: 'daily_revenue_below', label: 'Yesterday’s revenue was below', unit: 'currency' },
  { key: 'failed_jobs_above', label: 'Failed background jobs exceed', unit: 'jobs' },
] as const satisfies readonly { key: string; label: string; unit: string; hint?: string; param?: string }[];
export type AlertMetric = (typeof ALERT_METRICS)[number]['key'];
export const ALERT_METRIC_KEYS = ALERT_METRICS.map((m) => m.key) as [AlertMetric, ...AlertMetric[]];
