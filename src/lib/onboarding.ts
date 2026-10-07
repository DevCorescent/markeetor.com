import { z } from 'zod';
import { homepageSchema, SAFE_HREF } from './homepage';

/**
 * Business onboarding forms — shared by the admin builder (live preview), the public form page and the
 * server (validation). Everything about a form lives in one JSON config.
 */

export const FIELD_TYPES = ['text', 'textarea', 'email', 'phone', 'url', 'number', 'select', 'multiselect', 'radio', 'checkbox', 'date', 'country', 'rating', 'consent', 'heading', 'paragraph', 'divider'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const LAYOUT_TYPES: FieldType[] = ['heading', 'paragraph', 'divider'];

/** Keys the platform needs to create a workspace. These fields can be relabelled but not removed. */
export const CORE_KEYS = ['businessName', 'contactName', 'email'] as const;
/** Optional keys that map onto the organization profile when present. */
export const MAPPED_KEYS = { phone: 'Contact phone', website: 'Website', industry: 'Industry', country: 'Country' } as const;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const key = z.string().min(1).max(40).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Keys use letters, numbers and _');

export const fieldSchema = z.object({
  id: z.string().min(1).max(40),
  key,
  type: z.enum(FIELD_TYPES),
  label: z.string().trim().max(160).default(''),
  placeholder: z.string().trim().max(160).optional(),
  help: z.string().trim().max(300).optional(),
  required: z.boolean().default(false),
  width: z.enum(['full', 'half']).default('full'),
  options: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number().int().min(1).max(5000).optional(),
  defaultValue: z.string().max(500).optional(),
  step: z.number().int().min(0).max(9).default(0),
  showIf: z.object({ key, op: z.enum(['equals', 'not_equals', 'contains', 'filled', 'empty']), value: z.string().max(200).optional() }).nullable().optional(),
});
export type FormField = z.infer<typeof fieldSchema>;

export const formConfigSchema = z.object({
  steps: z.array(z.object({ id: z.string().min(1).max(40), title: z.string().trim().max(80), description: z.string().trim().max(200).optional() })).min(1).max(8),
  fields: z.array(fieldSchema).min(1).max(80),
  design: z.object({
    theme: z.enum(['light', 'dark', 'auto']).default('light'),
    accent: hex.default('#0b0b0b'),
    background: z.enum(['plain', 'gradient', 'grid', 'dots', 'image']).default('grid'),
    gradientFrom: hex.default('#f7f7f5'),
    gradientTo: hex.default('#e8e8e4'),
    layout: z.enum(['centered', 'split-left', 'split-right', 'minimal']).default('split-left'),
    font: z.enum(['geist', 'inter', 'serif', 'mono']).default('geist'),
    radius: z.number().int().min(0).max(24).default(10),
    density: z.enum(['comfortable', 'compact']).default('comfortable'),
    inputStyle: z.enum(['outline', 'filled', 'underline']).default('outline'),
    buttonStyle: z.enum(['solid', 'outline', 'pill']).default('solid'),
    width: z.enum(['narrow', 'normal', 'wide']).default('normal'),
    progress: z.enum(['bar', 'steps', 'none']).default('steps'),
    showLogo: z.boolean().default(true),
    animate: z.boolean().default(true),
  }),
  content: z.object({
    badge: z.string().trim().max(60).default(''),
    title: z.string().trim().min(1).max(120),
    subtitle: z.string().trim().max(300).default(''),
    submitLabel: z.string().trim().max(40).default('Submit application'),
    nextLabel: z.string().trim().max(40).default('Continue'),
    backLabel: z.string().trim().max(40).default('Back'),
    successTitle: z.string().trim().max(120).default('Application received'),
    successMessage: z.string().trim().max(600).default(''),
    sideTitle: z.string().trim().max(120).default(''),
    sideText: z.string().trim().max(600).default(''),
    benefits: z.array(z.string().trim().min(1).max(140)).max(8).default([]),
    stats: z.array(z.object({ value: z.string().trim().max(20), label: z.string().trim().max(40) })).max(4).default([]),
    testimonial: z.object({ quote: z.string().trim().max(300), author: z.string().trim().max(80), role: z.string().trim().max(80).default('') }).nullable().default(null),
    footer: z.string().trim().max(300).default(''),
    termsUrl: z.string().trim().max(300).regex(SAFE_HREF, 'Enter a https:// link').default(''),
    privacyUrl: z.string().trim().max(300).regex(SAFE_HREF, 'Enter a https:// link').default(''),
  }),
  settings: z.object({
    requireBusinessEmail: z.boolean().default(false),
    blockDisposable: z.boolean().default(true),
    autoApprove: z.boolean().default(false),
    notifyAdmins: z.boolean().default(true),
    sendConfirmation: z.boolean().default(true),
    confirmationMessage: z.string().trim().max(1000).default(''),
    maxSubmissions: z.number().int().min(1).max(1_000_000).nullable().default(null),
    closesAt: z.string().max(40).nullable().default(null),
    closedMessage: z.string().trim().max(300).default('This form is no longer accepting applications.'),
    minSeconds: z.number().int().min(0).max(120).default(4),
    leadFinder: z.object({ enabled: z.boolean().default(false), title: z.string().trim().max(80).default('What kind of leads are you looking for?'), description: z.string().trim().max(240).default('Describe your ideal customers — we’ll show you how many matching leads are available right now.'), required: z.boolean().default(false) }).default({ enabled: false, title: 'What kind of leads are you looking for?', description: '', required: false }),
    activation: z.object({
      maxUsers: z.number().int().min(1).max(10_000).default(5),
      maxActiveLeads: z.number().int().min(0).max(10_000_000).default(500),
      dailyAllocationLimit: z.number().int().min(0).max(1_000_000).default(100),
      monthlyAllocationLimit: z.number().int().min(0).max(10_000_000).default(2000),
    }).default({ maxUsers: 5, maxActiveLeads: 500, dailyAllocationLimit: 100, monthlyAllocationLimit: 2000 }),
  }),
  /** Optional landing page built around this form (see lib/homepage). */
  homepage: homepageSchema.optional(),
});
export type FormConfig = z.infer<typeof formConfigSchema>;

let n = 0;
export const fid = () => `f${Date.now().toString(36)}${(n++).toString(36)}`;

export function defaultFormConfig(productName = 'our platform'): FormConfig {
  return formConfigSchema.parse({
    steps: [{ id: 's1', title: 'Your business', description: 'Tell us who you are' }, { id: 's2', title: 'Your goals', description: 'Help us tailor your workspace' }],
    fields: [
      { id: fid(), key: 'businessName', type: 'text', label: 'Business name', placeholder: 'Acme Realty', required: true, width: 'half', step: 0 },
      { id: fid(), key: 'website', type: 'url', label: 'Website', placeholder: 'https://acme.com', width: 'half', step: 0 },
      { id: fid(), key: 'contactName', type: 'text', label: 'Your name', placeholder: 'Jane Doe', required: true, width: 'half', step: 0 },
      { id: fid(), key: 'email', type: 'email', label: 'Work email', placeholder: 'jane@acme.com', required: true, width: 'half', step: 0 },
      { id: fid(), key: 'phone', type: 'phone', label: 'Phone', placeholder: '+1 555 000 1234', width: 'half', step: 0 },
      { id: fid(), key: 'country', type: 'country', label: 'Country', width: 'half', step: 0 },
      { id: fid(), key: 'industry', type: 'select', label: 'Industry', options: ['Real Estate', 'Insurance', 'Financial Services', 'Solar & Energy', 'Healthcare', 'Education', 'Automotive', 'Technology', 'Other'], required: true, width: 'half', step: 1 },
      { id: fid(), key: 'teamSize', type: 'radio', label: 'Sales team size', options: ['Just me', '2–10', '11–50', '50+'], width: 'half', step: 1 },
      { id: fid(), key: 'monthlyLeads', type: 'select', label: 'Leads you need per month', options: ['Under 100', '100–500', '500–2,000', '2,000+'], width: 'half', step: 1 },
      { id: fid(), key: 'source', type: 'select', label: 'How did you hear about us?', options: ['Search', 'Referral', 'Social media', 'Event', 'Other'], width: 'half', step: 1 },
      { id: fid(), key: 'notes', type: 'textarea', label: 'Anything else we should know?', step: 1 },
      { id: fid(), key: 'consent', type: 'consent', label: 'I agree to the terms and privacy policy.', required: true, step: 1 },
    ],
    design: {},
    content: {
      badge: 'Partner program',
      title: `Grow your pipeline with ${productName}`,
      subtitle: 'Apply for a workspace. Once approved you get your own dashboard, verified leads and free demo leads to start.',
      successMessage: 'Thanks! Our team reviews every application, usually within one business day. You’ll receive an email with your login link as soon as your workspace is activated.',
      sideTitle: 'Everything you need to win more deals',
      sideText: 'A private CRM workspace, a lead marketplace with verified prospects and tools to turn them into customers.',
      benefits: ['Verified, exclusive leads delivered to your workspace', 'Free demo leads to try it risk-free', 'Pipeline, tasks, funnels and email campaigns built in', 'Enterprise-grade security and privacy'],
      stats: [{ value: '24h', label: 'Average approval time' }, { value: '10', label: 'Free demo leads' }],
    },
    settings: {},
  });
}

/** Whether a field is shown, given current answers (conditional logic). Layout fields are always visible. */
export function isVisible(f: FormField, answers: Record<string, unknown>) {
  if (!f.showIf) return true;
  const v = answers[f.showIf.key];
  const s = Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
  const target = (f.showIf.value ?? '').toLowerCase();
  switch (f.showIf.op) {
    case 'equals': return s.some((x) => x.toLowerCase() === target);
    case 'not_equals': return !s.some((x) => x.toLowerCase() === target);
    case 'contains': return s.some((x) => x.toLowerCase().includes(target));
    case 'filled': return s.some((x) => x.trim() !== '' && x !== 'false');
    case 'empty': return !s.some((x) => x.trim() !== '' && x !== 'false');
  }
}

// ── Email intelligence ─────────────────────────────────────────────

export const FREE_EMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'gmx.com', 'gmx.net', 'yandex.com', 'mail.com', 'rediffmail.com', 'qq.com', '163.com']);
export const DISPOSABLE_DOMAINS = new Set(['mailinator.com', '10minutemail.com', 'guerrillamail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'getnada.com', 'sharklasers.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com']);

export const emailDomain = (email: string) => email.trim().toLowerCase().split('@')[1] ?? '';
export const isFreeEmail = (email: string) => FREE_EMAIL_DOMAINS.has(emailDomain(email));
export const isDisposableEmail = (email: string) => DISPOSABLE_DOMAINS.has(emailDomain(email));

/** "acme-realty.co.uk" → "Acme Realty" — a starting point for the business name. */
export function companyFromDomain(domain: string) {
  const label = domain.replace(/^www\./, '').split('.')[0] ?? '';
  return label.split(/[-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function websiteDomain(url: string) {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export type Answers = Record<string, string | string[] | boolean | number | null>;

// ── Validation (browser + server) ─────────────────────────────────

export const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Validates answers against the form definition. Hidden (conditional) fields are ignored. */
export function validateAnswers(c: Pick<FormConfig, 'fields'>, answers: Answers, onlyStep?: number) {
  const errors: Record<string, string> = {};
  const clean: Answers = {};
  for (const f of c.fields) {
    if (LAYOUT_TYPES.includes(f.type) || !isVisible(f, answers) || (onlyStep != null && f.step !== onlyStep)) continue;
    let v = answers[f.key];
    if (typeof v === 'string') v = v.trim();
    const empty = v == null || v === '' || v === false || (Array.isArray(v) && !v.length);
    if (empty) {
      if (f.required) errors[f.key] = f.type === 'consent' ? 'Please accept to continue' : 'This field is required';
      continue;
    }
    const s = String(v);
    switch (f.type) {
      case 'email': if (!EMAIL_RE.test(s)) errors[f.key] = 'Enter a valid email address'; break;
      case 'url': if (!URL_RE.test(s.includes('://') ? s : `https://${s}`)) errors[f.key] = 'Enter a valid web address'; else v = s.includes('://') ? s : `https://${s}`; break;
      case 'phone': if (s.replace(/[^\d]/g, '').length < 7) errors[f.key] = 'Enter a valid phone number'; break;
      case 'number': case 'rating': {
        const num = Number(v);
        if (!Number.isFinite(num)) errors[f.key] = 'Enter a number';
        else if (f.min != null && num < f.min) errors[f.key] = `Must be at least ${f.min}`;
        else if (f.max != null && num > f.max) errors[f.key] = `Must be at most ${f.max}`;
        v = num;
        break;
      }
      case 'select': case 'radio': if (f.options?.length && !f.options.includes(s)) errors[f.key] = 'Choose one of the options'; break;
      case 'multiselect': if (!Array.isArray(v) || (f.options?.length && v.some((x) => !f.options!.includes(x)))) errors[f.key] = 'Choose from the options'; break;
      case 'consent': case 'checkbox': v = v === true || v === 'true'; break;
    }
    if (typeof v === 'string' && v.length > (f.maxLength ?? (f.type === 'textarea' ? 5000 : 300))) errors[f.key] = 'Too long';
    clean[f.key] = v;
  }
  return { errors, clean };
}

