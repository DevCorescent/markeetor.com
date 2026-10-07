import { z } from 'zod';

/**
 * Email endpoints: named triggers (a platform event or an inbound webhook) with the emails attached to
 * them. Shared by the server (validation, delivery) and the admin UI (forms, samples).
 */

export type EndpointEventDef = {
  key: string;
  label: string;
  description: string;
  /** Payload path suggested as the recipient. */
  recipientPath: string;
  namePath: string | null;
  sample: Record<string, unknown>;
};

const lead = { id: 'lead_123', fullName: 'Jordan Rivera', firstName: 'Jordan', lastName: 'Rivera', email: 'jordan@northwind.example', phone: '+14155550111', company: 'Northwind Traders', jobTitle: 'Operations Director', city: 'Austin', state: 'Texas', country: 'United States', industry: 'Logistics', source: 'Expo', campaign: 'Spring 2026', score: 72 };
const organization = { id: 'org_123', name: 'Northwind Traders', code: 'ORG-7K2Q', contactEmail: 'ops@northwind.example', industry: 'Logistics' };

export const ENDPOINT_EVENTS: EndpointEventDef[] = [
  {
    key: 'lead.created', label: 'Lead added to the repository', description: 'Once for every new lead an import inserts (updated duplicates are not included).',
    recipientPath: 'lead.email', namePath: 'lead.fullName', sample: { lead, import: { id: 'imp_123', code: 'IMP-4F2A', source: 'Expo' } },
  },
  {
    key: 'import.completed', label: 'Import completed', description: 'Once per finished import, with its totals. Good for notifying your team.',
    recipientPath: 'uploadedBy.email', namePath: 'uploadedBy.name',
    sample: { import: { id: 'imp_123', code: 'IMP-4F2A', fileName: 'expo-leads.csv', source: 'Expo', campaign: 'Spring 2026', inserted: 412, updated: 18, skipped: 9, invalid: 3 }, uploadedBy: { name: 'Priya Nair', email: 'ops@markeetor.example' } },
  },
  {
    key: 'leads.distributed', label: 'Leads delivered to a client', description: 'Once per client per distribution batch, with how many leads they received.',
    recipientPath: 'organization.contactEmail', namePath: 'organization.name', sample: { organization, batch: { id: 'bat_123', code: 'DST-91XQ' }, leadCount: 25 },
  },
  {
    key: 'organization.created', label: 'Client workspace created', description: 'When a workspace is created by an admin, an approved application or a welcome email.',
    recipientPath: 'organization.contactEmail', namePath: 'organization.name', sample: { organization, via: 'admin' },
  },
  {
    key: 'account.welcome_created', label: 'Lead account created by welcome email', description: 'When a welcome email creates a workspace and account for a lead.',
    recipientPath: 'user.email', namePath: 'user.name', sample: { user: { name: 'Jordan Rivera', email: 'jordan@northwind.example' }, organization, lead },
  },
  {
    key: 'onboarding.submitted', label: 'Onboarding application submitted', description: 'When someone applies for a workspace through an onboarding form.',
    recipientPath: 'application.email', namePath: 'application.contactName',
    sample: { application: { id: 'app_123', businessName: 'Northwind Traders', contactName: 'Jordan Rivera', email: 'jordan@northwind.example', phone: '+14155550111', website: 'https://northwind.example', industry: 'Logistics', country: 'United States', quality: 80 }, form: { name: 'Get started' } },
  },
  {
    key: 'order.created', label: 'Marketplace order placed', description: 'When a client requests leads from the marketplace.',
    recipientPath: 'requestedBy.email', namePath: 'requestedBy.name',
    sample: { order: { id: 'req_123', code: 'REQ-5521', leadCount: 50, total: 125, currency: 'USD', paymentMethod: 'INVOICE' }, organization, requestedBy: { name: 'Jordan Rivera', email: 'jordan@northwind.example' } },
  },
  {
    key: 'order.fulfilled', label: 'Marketplace order delivered', description: 'When a marketplace order is approved and its leads are delivered.',
    recipientPath: 'requestedBy.email', namePath: 'requestedBy.name',
    sample: { order: { id: 'req_123', code: 'REQ-5521', leadCount: 50, deliveredCount: 50, total: 125, currency: 'USD' }, organization, requestedBy: { name: 'Jordan Rivera', email: 'jordan@northwind.example' } },
  },
];

export const WEBHOOK_SAMPLE = { email: 'jordan@northwind.example', name: 'Jordan Rivera', company: 'Northwind Traders', plan: 'Pro', orderId: 'A-1042' };

export const CONDITION_OPS = [
  { key: 'eq', label: 'equals' }, { key: 'neq', label: 'does not equal' },
  { key: 'contains', label: 'contains' }, { key: 'not_contains', label: 'does not contain' },
  { key: 'starts_with', label: 'starts with' }, { key: 'ends_with', label: 'ends with' },
  { key: 'in', label: 'is one of' }, { key: 'not_in', label: 'is not one of' },
  { key: 'gt', label: '>' }, { key: 'gte', label: '≥' }, { key: 'lt', label: '<' }, { key: 'lte', label: '≤' },
  { key: 'exists', label: 'is present' }, { key: 'not_exists', label: 'is empty' },
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number]['key'];

const path = z.string().trim().max(200).regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, 'Use dotted paths like lead.email or items.0.email');
const email = z.string().trim().toLowerCase().email().max(254);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const minutes = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3));

export const endpointConfigSchema = z.object({
  recipients: z.object({
    fromPayload: z.boolean(),
    path: path.or(z.literal('')),
    namePath: path.or(z.literal('')),
    fixed: z.array(email).max(50),
    cc: z.array(email).max(20),
    bcc: z.array(email).max(20),
    replyTo: email.nullable(),
    /** Most recipients one trigger may produce. */
    max: z.number().int().min(1).max(100),
  }),
  conditions: z.object({
    match: z.enum(['all', 'any']),
    rules: z.array(z.object({ path, op: z.enum(CONDITION_OPS.map((o) => o.key) as [ConditionOp, ...ConditionOp[]]), value: z.string().max(500) })).max(25),
  }),
  /** The emails attached to this endpoint, sent in order after their delays. */
  steps: z.array(z.object({
    id: z.string().min(1).max(40),
    templateId: z.string().min(1).max(64),
    delayMinutes: z.number().int().min(0).max(90 * 24 * 60),
    subject: z.string().trim().max(300).nullable(),
    enabled: z.boolean(),
  })).min(1, 'Attach at least one email').max(10),
  /** Extra {{variables}} read from the payload (every payload field is available automatically too). */
  variables: z.array(z.object({ name: z.string().regex(/^[A-Za-z]{1,40}$/, 'Letters only'), path, fallback: z.string().max(300) })).max(50),
  delivery: z.object({
    sendWindow: z.object({ enabled: z.boolean(), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: hhmm, end: hhmm, timezone: z.string().max(60) })
      .refine((w) => !w.enabled || minutes(w.end) > minutes(w.start), 'The window must end after it starts'),
    /** Skip a recipient this endpoint already emailed (same email step) within this many minutes. 0 = off. */
    dedupeMinutes: z.number().int().min(0).max(60 * 24 * 90),
    frequencyCap: z.object({ enabled: z.boolean(), max: z.number().int().min(1).max(1000), hours: z.number().int().min(1).max(24 * 90) }),
    maxTriggersPerHour: z.number().int().min(1).max(1_000_000),
    /** Payload path whose value makes a trigger unique (a repeat is ignored). Webhooks may also send an Idempotency-Key header. */
    idempotencyPath: path.or(z.literal('')),
    trackOpens: z.boolean(),
    trackClicks: z.boolean(),
    testMode: z.boolean(),
    testRecipients: z.array(email).max(10),
    /** Days to keep trigger payloads and message variables before they are erased. */
    retentionDays: z.number().int().min(1).max(365),
  }),
  webhook: z.object({ requireSignature: z.boolean(), ipAllowlist: z.array(z.string().trim().min(1).max(64)).max(50) }),
});
export type EndpointConfig = z.infer<typeof endpointConfigSchema>;

export const endpointInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable(),
  status: z.enum(['ACTIVE', 'PAUSED']),
  triggerType: z.enum(['EVENT', 'WEBHOOK']),
  event: z.string().max(60).nullable(),
  category: z.enum(['TRANSACTIONAL', 'MARKETING']),
  smtpAccountId: z.string().max(64).nullable(),
  config: endpointConfigSchema,
}).superRefine((v, ctx) => {
  if (v.triggerType === 'EVENT' && !ENDPOINT_EVENTS.some((e) => e.key === v.event)) ctx.addIssue({ code: 'custom', path: ['event'], message: 'Choose an event' });
  if (!v.config.recipients.fromPayload && !v.config.recipients.fixed.length) ctx.addIssue({ code: 'custom', path: ['config', 'recipients'], message: 'Add at least one recipient' });
  if (v.config.recipients.fromPayload && !v.config.recipients.path) ctx.addIssue({ code: 'custom', path: ['config', 'recipients', 'path'], message: 'Enter the payload field that holds the email address' });
  if (v.config.delivery.testMode && !v.config.delivery.testRecipients.length) ctx.addIssue({ code: 'custom', path: ['config', 'delivery', 'testRecipients'], message: 'Test mode needs at least one test recipient' });
});
export type EndpointInput = z.infer<typeof endpointInputSchema>;

export function defaultEndpointConfig(event?: EndpointEventDef): EndpointConfig {
  return {
    recipients: { fromPayload: true, path: event?.recipientPath ?? 'email', namePath: event?.namePath ?? 'name', fixed: [], cc: [], bcc: [], replyTo: null, max: 10 },
    conditions: { match: 'all', rules: [] },
    steps: [],
    variables: [],
    delivery: {
      sendWindow: { enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', timezone: 'UTC' },
      dedupeMinutes: 0,
      frequencyCap: { enabled: false, max: 3, hours: 24 },
      maxTriggersPerHour: 5000,
      idempotencyPath: '',
      trackOpens: true,
      trackClicks: true,
      testMode: false,
      testRecipients: [],
      retentionDays: 30,
    },
    webhook: { requireSignature: false, ipAllowlist: [] },
  };
}

/** Reads a dotted path (`lead.email`, `items.0.email`) from a payload. */
export function getPath(obj: unknown, p: string): unknown {
  if (!p) return undefined;
  let cur: unknown = obj;
  for (const part of p.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = /^\d+$/.test(part) ? cur[Number(part)] : undefined;
    else if (typeof cur === 'object') cur = Object.prototype.hasOwnProperty.call(cur, part) ? (cur as Record<string, unknown>)[part] : undefined;
    else return undefined;
  }
  return cur;
}

const scalar = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v));

/**
 * Template variables from a payload: every scalar field by its own name (`lead.company` → `{{company}}`)
 * and by its full camel-cased path (`{{leadCompany}}`); top-level fields win name clashes.
 */
export function payloadVariables(payload: unknown, mappings: EndpointConfig['variables'] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const byPath: Record<string, string> = {};
  const walk = (v: unknown, keys: string[], depth: number) => {
    if (depth > 6 || v === null || v === undefined) return;
    if (Array.isArray(v)) return;
    if (typeof v === 'object') {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) if (/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) walk(child, [...keys, k], depth + 1);
      return;
    }
    const name = keys.map((k, i) => (i === 0 ? k : k[0].toUpperCase() + k.slice(1))).join('').replace(/[^A-Za-z]/g, '');
    if (name) byPath[name] = scalar(v);
    const leaf = keys[keys.length - 1].replace(/[^A-Za-z]/g, '');
    if (leaf && (keys.length === 1 || !(leaf in out))) out[leaf] = scalar(v);
  };
  walk(payload, [], 0);
  Object.assign(out, byPath);
  for (const m of mappings) out[m.name] = scalar(getPath(payload, m.path)) || m.fallback;
  return out;
}

export function evaluateConditions(payload: unknown, c: EndpointConfig['conditions']): boolean {
  if (!c.rules.length) return true;
  const test = (r: EndpointConfig['conditions']['rules'][number]) => {
    const raw = getPath(payload, r.path);
    const v = Array.isArray(raw) ? raw.map(scalar).join(',') : scalar(raw);
    const a = v.toLowerCase();
    const b = r.value.trim().toLowerCase();
    const list = b.split(',').map((x) => x.trim()).filter(Boolean);
    const num = (x: string) => (x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : NaN);
    switch (r.op) {
      case 'eq': return a === b;
      case 'neq': return a !== b;
      case 'contains': return a.includes(b);
      case 'not_contains': return !a.includes(b);
      case 'starts_with': return a.startsWith(b);
      case 'ends_with': return a.endsWith(b);
      case 'in': return list.includes(a);
      case 'not_in': return !list.includes(a);
      case 'gt': return num(v) > num(r.value);
      case 'gte': return num(v) >= num(r.value);
      case 'lt': return num(v) < num(r.value);
      case 'lte': return num(v) <= num(r.value);
      case 'exists': return a !== '';
      case 'not_exists': return a === '';
    }
  };
  return c.match === 'all' ? c.rules.every(test) : c.rules.some(test);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The earliest moment at or after `at` that falls inside the send window. */
export function nextInWindow(w: EndpointConfig['delivery']['sendWindow'], at: Date): Date {
  if (!w.enabled) return at;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: w.timezone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(at).map((p) => [p.type, p.value]));
  const day = WEEKDAYS.indexOf(String(parts.weekday));
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  const start = minutes(w.start);
  const end = minutes(w.end);
  for (let d = 0; d <= 7; d++) {
    if (!w.days.includes((day + d) % 7)) continue;
    if (d === 0) {
      if (now >= start && now < end) return at;
      if (now < start) return new Date(at.getTime() + (start - now) * 60_000);
      continue;
    }
    return new Date(at.getTime() + (d * 1440 + start - now) * 60_000);
  }
  return at;
}
