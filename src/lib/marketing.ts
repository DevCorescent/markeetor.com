import { z } from 'zod';

/** Marketing tools: platform controls (Admin → Marketing) and shared shapes for sequences, forms and messages. */

export const MARKETING_FEATURES = [
  { key: 'sequences', label: 'Follow-up sequences', hint: 'Automated multi-step email / WhatsApp / SMS / task follow-ups' },
  { key: 'whatsapp', label: 'WhatsApp messaging', hint: 'Send WhatsApp messages from the platform' },
  { key: 'sms', label: 'SMS messaging', hint: 'Send SMS from the platform' },
  { key: 'broadcasts', label: 'Broadcasts', hint: 'One-off WhatsApp / SMS sends to a segment' },
  { key: 'segments', label: 'Segments', hint: 'Saved, always-current lead groups' },
  { key: 'aiWriter', label: 'AI writer', hint: 'AI-written emails, messages, posts and ads' },
  { key: 'links', label: 'Tracked links & QR codes', hint: 'Short links with click tracking and QR codes' },
  { key: 'forms', label: 'Lead capture forms', hint: 'Hosted and embeddable forms that create leads' },
] as const;
export type MarketingFeature = (typeof MARKETING_FEATURES)[number]['key'];
const FEATURE_KEYS = MARKETING_FEATURES.map((f) => f.key) as [MarketingFeature, ...MarketingFeature[]];
const featureFlags = z.object(Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean().default(true)])) as Record<MarketingFeature, z.ZodDefault<z.ZodBoolean>>);

export const marketingSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  features: featureFlags.default(Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])) as Record<MarketingFeature, boolean>),
  /** Credits charged per action (0 = free). */
  pricing: z.object({
    whatsapp: z.number().min(0).max(10_000).default(1),
    sms: z.number().min(0).max(10_000).default(1),
    aiDraft: z.number().min(0).max(10_000).default(2),
  }).default({ whatsapp: 1, sms: 1, aiDraft: 2 }),
  limits: z.object({
    messagesPerDay: z.number().int().min(0).max(1_000_000).default(1000),
    sequences: z.number().int().min(0).max(500).default(20),
    stepsPerSequence: z.number().int().min(1).max(30).default(10),
    forms: z.number().int().min(0).max(500).default(10),
    links: z.number().int().min(0).max(10_000).default(200),
    aiDraftsPerDay: z.number().int().min(0).max(10_000).default(100),
    segments: z.number().int().min(0).max(500).default(30),
  }).default({ messagesPerDay: 1000, sequences: 20, stepsPerSequence: 10, forms: 10, links: 200, aiDraftsPerDay: 100, segments: 30 }),
  /** No WhatsApp / SMS at night in the platform time zone; sends wait until the window opens. */
  quietHours: z.object({
    enabled: z.boolean().default(true),
    start: z.number().int().min(0).max(23).default(21),
    end: z.number().int().min(0).max(23).default(9),
    timezone: z.string().default('Asia/Kolkata'),
  }).default({ enabled: true, start: 21, end: 9, timezone: 'Asia/Kolkata' }),
  moderation: z.object({
    /** New capture forms go live only after review. */
    reviewForms: z.boolean().default(false),
    /** Broadcasts above this many recipients wait for approval (0 = never). */
    reviewBroadcastsAbove: z.number().int().min(0).max(1_000_000).default(500),
    blockedWords: z.array(z.string().trim().min(2).max(40)).max(200).default([]),
  }).default({ reviewForms: false, reviewBroadcastsAbove: 500, blockedWords: [] }),
  /** Delivery: off, log only (test — nothing leaves the platform), or a real provider (credentials in env). */
  providers: z.object({
    whatsapp: z.enum(['off', 'log', 'cloud']).default('log'),
    sms: z.enum(['off', 'log', 'twilio']).default('log'),
  }).default({ whatsapp: 'log', sms: 'log' }),
  /** Per-client feature switches and limits. */
  overrides: z.array(z.object({
    organizationId: z.string().min(1),
    features: z.partialRecord(z.enum(FEATURE_KEYS), z.boolean()).default({}),
    messagesPerDay: z.number().int().min(0).max(1_000_000).nullable().default(null),
  })).max(1000).default([]),
});
export type MarketingSettings = z.infer<typeof marketingSettingsSchema>;
export const DEFAULT_MARKETING: MarketingSettings = marketingSettingsSchema.parse({});

/** Effective features for one workspace. */
export function featuresFor(s: MarketingSettings, orgId: string): Record<MarketingFeature, boolean> {
  const o = s.overrides.find((x) => x.organizationId === orgId);
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, s.enabled && (o?.features[k] ?? s.features[k])])) as Record<MarketingFeature, boolean>;
}

// ── Sequences ──────────────────────────────────────────────────────

export const stepSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(['email', 'whatsapp', 'sms', 'task']),
  /** Hours after the previous step (or enrolment). */
  delayHours: z.number().int().min(0).max(24 * 90),
  templateId: z.string().max(64).nullable().optional(),
  body: z.string().trim().max(1600).nullable().optional(),
  title: z.string().trim().max(200).nullable().optional(),
});
export type SequenceStep = z.infer<typeof stepSchema>;

export const sequenceInput = z.object({
  name: z.string().trim().min(2).max(120),
  steps: z.array(stepSchema).min(1).max(30),
  stopOnReply: z.boolean().default(true),
  stopOnStatus: z.array(z.enum(['CONTACTED', 'QUALIFIED', 'NEGOTIATION', 'CONVERTED', 'LOST'])).default(['CONVERTED', 'LOST']),
  segmentId: z.string().max(64).nullable().default(null),
  autoEnroll: z.boolean().default(false),
});

// ── Capture forms ──────────────────────────────────────────────────

export const FORM_FIELD_TYPES = ['text', 'email', 'phone', 'textarea', 'select', 'number'] as const;
export const formConfigSchema = z.object({
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(600).default(''),
  fields: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    label: z.string().trim().min(1).max(80),
    type: z.enum(FORM_FIELD_TYPES),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    /** Which lead field it fills. */
    mapTo: z.enum(['fullName', 'email', 'phone', 'company', 'jobTitle', 'city', 'note', 'custom']).default('custom'),
  })).min(1).max(20),
  button: z.string().trim().min(1).max(40).default('Submit'),
  thankYou: z.string().trim().max(400).default('Thank you! We’ll be in touch shortly.'),
  redirectUrl: z.string().trim().url().max(500).nullable().default(null),
  /** Consent checkbox for WhatsApp / SMS / email follow-up. */
  consent: z.boolean().default(true),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#111111'),
});
export type FormConfig = z.infer<typeof formConfigSchema>;

export const DEFAULT_FORM: FormConfig = formConfigSchema.parse({
  title: 'Get in touch',
  description: 'Tell us a little about your needs and we’ll get back to you.',
  fields: [
    { key: 'name', label: 'Full name', type: 'text', required: true, mapTo: 'fullName' },
    { key: 'phone', label: 'Phone / WhatsApp', type: 'phone', required: true, mapTo: 'phone' },
    { key: 'email', label: 'Email', type: 'email', required: false, mapTo: 'email' },
    { key: 'company', label: 'Company', type: 'text', required: false, mapTo: 'company' },
    { key: 'message', label: 'How can we help?', type: 'textarea', required: false, mapTo: 'note' },
  ],
});

// ── Personalisation ────────────────────────────────────────────────

export const MERGE_TAGS = ['first_name', 'name', 'company', 'city', 'sender_name', 'workspace'] as const;

/** Fills {first_name}, {company}… and {link:CODE} (tracked links). Unknown tags are left empty. */
export function renderMessage(body: string, vars: Partial<Record<(typeof MERGE_TAGS)[number], string | null>>, link: (code: string) => string = (c) => c) {
  return body
    .replace(/\{link:([A-Za-z0-9_-]{3,24})\}/g, (_, code: string) => link(code))
    .replace(/\{(first_name|name|company|city|sender_name|workspace)(?:\|([^}]{0,40}))?\}/g, (_, k: string, fallback?: string) => (vars[k as keyof typeof vars] || fallback || '').trim())
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Blocked-word check for message bodies and forms. */
export const blockedIn = (text: string, words: string[]) => words.find((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) ?? null;

/** Whether a moment falls inside quiet hours, and when the window next opens. */
export function quietWindow(at: Date, q: { enabled: boolean; start: number; end: number; timezone: string }) {
  if (!q.enabled) return { quiet: false, opensAt: at };
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: q.timezone }).format(at));
  const quiet = q.start > q.end ? hour >= q.start || hour < q.end : hour >= q.start && hour < q.end;
  if (!quiet) return { quiet: false, opensAt: at };
  const hoursToOpen = (q.end - hour + 24) % 24 || 24;
  const opens = new Date(at.getTime() + hoursToOpen * 3_600_000);
  opens.setMinutes(0, 0, 0);
  return { quiet: true, opensAt: opens };
}
