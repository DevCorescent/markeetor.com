import { z } from 'zod';

/**
 * Site homepage built around an onboarding form. Lives in the form config (`config.homepage`) so a form
 * carries its own landing page; the platform setting `homepage.formId` decides which form serves `/`.
 */

export const SECTION_TYPES = ['hero', 'logos', 'stats', 'features', 'steps', 'testimonials', 'faq', 'cta', 'form', 'content'] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export const SECTION_ICONS = ['sparkles', 'shield', 'zap', 'target', 'users', 'chart', 'mail', 'globe', 'clock', 'check', 'star', 'rocket', 'database', 'filter', 'layers', 'handshake', 'phone', 'trophy'] as const;
export type SectionIcon = (typeof SECTION_ICONS)[number];

const text = (max: number) => z.string().trim().max(max).default('');
/** Only web, relative, anchor, mail and phone links — never `javascript:` or other schemes. */
export const SAFE_HREF = /^(https?:\/\/|\/(?!\/)|#|mailto:|tel:|$)/i;
const href = z.string().trim().max(300).regex(SAFE_HREF, 'Use a https://, /path, #anchor, mailto: or tel: link');
const link = z.object({
  label: z.string().trim().max(40),
  /** `form` scrolls to the application form, `login` opens sign-in, `url` follows `href` (absolute, or `#anchor`). */
  action: z.enum(['form', 'login', 'url']).default('form'),
  href: href.default(''),
});
export type HomeLink = z.infer<typeof link>;

const item = z.object({
  id: z.string().min(1).max(40),
  title: text(140),
  text: text(600),
  value: text(24),
  icon: z.enum(SECTION_ICONS).default('sparkles'),
  author: text(80),
  role: text(80),
});
export type SectionItem = z.infer<typeof item>;

export const sectionSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(SECTION_TYPES),
  enabled: z.boolean().default(true),
  /** Anchor for nav links (`#features`). Defaults to the section id. */
  anchor: z.string().trim().max(40).regex(/^[a-z0-9-]*$/, 'Use lowercase letters, numbers and dashes').default(''),
  background: z.enum(['default', 'muted', 'accent', 'inverted', 'glow', 'grid']).default('default'),
  spacing: z.enum(['compact', 'normal', 'spacious']).default('normal'),
  align: z.enum(['left', 'center']).default('center'),
  hideOnMobile: z.boolean().default(false),
  eyebrow: text(60),
  title: text(160),
  subtitle: text(400),
  body: text(4000),
  /** hero: form-right | form-left | centered | split-image. */
  layout: z.enum(['form-right', 'form-left', 'centered', 'split-image']).default('form-right'),
  columns: z.number().int().min(1).max(4).default(3),
  items: z.array(item).max(16).default([]),
  primary: link.nullable().default(null),
  secondary: link.nullable().default(null),
});
export type HomeSection = z.infer<typeof sectionSchema>;

/** Chat-first homepage: the Lead Finder is the whole page. */
export const finderPageSchema = z.object({
  /** `mono` matches the dashboards (platform theme, black & white); `brand` uses the form's theme and accent colour. */
  style: z.enum(['mono', 'brand']).default('mono'),
  eyebrow: z.string().trim().max(80).default('{free} free leads · No payment required'),
  title: z.string().trim().max(140).default('Find your next *customers* in seconds'),
  subtitle: z.string().trim().max(300).default('Describe who you want to reach. Our AI searches {count} verified leads and shows you matches instantly.'),
  placeholder: z.string().trim().max(140).default('e.g. Real estate decision-makers in California with phone numbers'),
  suggestions: z.array(z.string().trim().min(1).max(100)).max(6).default(['Decision-makers in real estate', 'Fresh leads added this week', 'Leads with phone numbers', 'Hot leads with score above 80']),
  trust: z.array(z.string().trim().min(1).max(60)).max(4).default(['No payment or card required', 'Verified, exclusive contacts', 'Delivered to your private dashboard']),
  claimLabel: z.string().trim().max(40).default('Claim my free leads'),
  background: z.enum(['aurora', 'glow', 'grid', 'plain']).default('grid'),
  showStats: z.boolean().default(true),
  showFaq: z.boolean().default(true),
});
export type FinderPage = z.infer<typeof finderPageSchema>;
export const defaultFinderPage = (): FinderPage => finderPageSchema.parse({});

export const homepageSchema = z.object({
  /** What `/` shows: the landing page sections, or the Lead Finder on its own. */
  mode: z.enum(['page', 'finder']).default('page'),
  finder: finderPageSchema.default(defaultFinderPage),
  nav: z.object({
    show: z.boolean().default(true),
    sticky: z.boolean().default(true),
    links: z.array(z.object({ label: z.string().trim().max(40), href })).max(6).default([]),
    showSignIn: z.boolean().default(true),
    signInLabel: z.string().trim().max(30).default('Sign in'),
    cta: link.nullable().default({ label: 'Apply now', action: 'form', href: '' }),
  }),
  sections: z.array(sectionSchema).max(24),
  footer: z.object({
    text: text(300),
    links: z.array(z.object({ label: z.string().trim().max(40), href })).max(8).default([]),
    showPoweredBy: z.boolean().default(true),
  }),
  seo: z.object({ title: text(120), description: text(300) }),
});
export type Homepage = z.infer<typeof homepageSchema>;

let n = 0;
export const hid = () => `h${Date.now().toString(36)}${(n++).toString(36)}`;
const it = (p: Partial<SectionItem>): SectionItem => ({ id: hid(), title: '', text: '', value: '', icon: 'sparkles', author: '', role: '', ...p });

export const SECTION_META: Record<SectionType, { label: string; hint: string }> = {
  hero: { label: 'Hero', hint: 'Headline, call to action and optionally the form' },
  logos: { label: 'Logo strip', hint: 'Names of customers or partners' },
  stats: { label: 'Stats', hint: 'Big numbers that build trust' },
  features: { label: 'Features', hint: 'Grid of benefits with icons' },
  steps: { label: 'How it works', hint: 'Numbered steps' },
  testimonials: { label: 'Testimonials', hint: 'Quotes from customers' },
  faq: { label: 'FAQ', hint: 'Expandable questions and answers' },
  cta: { label: 'Call to action', hint: 'Closing banner with buttons' },
  form: { label: 'Application form', hint: 'The onboarding form as its own section' },
  content: { label: 'Text block', hint: 'Free text, e.g. about or policy' },
};

/** A new section of the given type, pre-filled with sensible copy. */
export function newSection(type: SectionType): HomeSection {
  const base = sectionSchema.parse({ id: hid(), type });
  switch (type) {
    case 'hero': return { ...base, eyebrow: 'New', title: 'Your headline goes here', subtitle: 'One or two sentences on the value you deliver.', layout: 'centered', primary: { label: 'Get started', action: 'form', href: '' }, background: 'glow' };
    case 'logos': return { ...base, eyebrow: 'Trusted by growing teams', spacing: 'compact', items: ['Northwind', 'Summit Realty', 'Brightside', 'Atlas Insurance', 'Evergreen Solar'].map((t) => it({ title: t })) };
    case 'stats': return { ...base, columns: 4, items: [['10k+', 'Verified leads'], ['24h', 'Average approval'], ['3.2×', 'More meetings booked'], ['99.9%', 'Uptime']].map(([v, t]) => it({ value: v, title: t })) };
    case 'features': return { ...base, eyebrow: 'Why us', title: 'Everything you need to grow', subtitle: 'Tools built for teams that live in their pipeline.', items: [it({ icon: 'target', title: 'Feature one', text: 'Explain the benefit in a sentence.' }), it({ icon: 'zap', title: 'Feature two', text: 'Explain the benefit in a sentence.' }), it({ icon: 'shield', title: 'Feature three', text: 'Explain the benefit in a sentence.' })] };
    case 'steps': return { ...base, eyebrow: 'How it works', title: 'Up and running in three steps', items: [it({ title: 'Apply', text: 'Tell us about your business.' }), it({ title: 'Get approved', text: 'We review within one business day.' }), it({ title: 'Start closing', text: 'Leads arrive in your dashboard.' })] };
    case 'testimonials': return { ...base, eyebrow: 'Customers', title: 'Loved by sales teams', background: 'muted', items: [it({ text: 'A great quote from a happy customer.', author: 'Alex Morgan', role: 'Founder, Brightside' })] };
    case 'faq': return { ...base, title: 'Frequently asked questions', align: 'left', items: [it({ title: 'A common question?', text: 'A clear, short answer.' })] };
    case 'cta': return { ...base, title: 'Ready to grow your pipeline?', subtitle: 'Apply in minutes — free demo leads included.', background: 'inverted', primary: { label: 'Apply now', action: 'form', href: '' } };
    case 'form': return { ...base, eyebrow: 'Apply', title: 'Request your workspace', subtitle: 'It takes about two minutes.', background: 'muted' };
    case 'content': return { ...base, title: 'About us', body: 'Write anything here. Separate paragraphs with a blank line.', align: 'left' };
  }
}

export function defaultHomepage(c: { title: string; subtitle: string; badge: string; benefits: string[]; stats: { value: string; label: string }[]; testimonial: { quote: string; author: string; role: string } | null }, productName = 'our platform'): Homepage {
  const s = (type: SectionType, p: Partial<HomeSection>): HomeSection => ({ ...newSection(type), ...p });
  return homepageSchema.parse({
    nav: { links: [{ label: 'Features', href: '#features' }, { label: 'How it works', href: '#how-it-works' }, { label: 'FAQ', href: '#faq' }] },
    sections: [
      s('hero', { eyebrow: c.badge, title: c.title, subtitle: c.subtitle, layout: 'form-right', align: 'left', items: c.benefits.slice(0, 4).map((b) => it({ title: b })), primary: null, background: 'glow', spacing: 'spacious' }),
      s('logos', {}),
      s('features', {
        anchor: 'features', eyebrow: 'Platform', title: `Why teams choose ${productName}`, subtitle: 'Verified leads, a CRM that stays out of your way and automation that keeps every deal moving.',
        items: [
          it({ icon: 'target', title: 'Verified, exclusive leads', text: 'Every lead is validated before it reaches you, and never shared with competitors.' }),
          it({ icon: 'filter', title: 'Funnels & pipeline', text: 'See where deals stall and launch campaigns to exactly the right stage.' }),
          it({ icon: 'sparkles', title: 'AI Lead Finder', text: 'Describe your ideal customer and see matching leads instantly.' }),
          it({ icon: 'mail', title: 'Built-in email', text: 'Templates, tracking and automations without extra tools.' }),
          it({ icon: 'users', title: 'Team workspace', text: 'Roles, ownership and tasks so nothing slips through the cracks.' }),
          it({ icon: 'shield', title: 'Private & secure', text: 'Tenant isolation, audit trails and enterprise-grade security.' }),
        ],
      }),
      ...(c.stats.length ? [s('stats', { columns: Math.min(4, Math.max(2, c.stats.length)), background: 'muted', items: c.stats.map((x) => it({ value: x.value, title: x.label })) })] : []),
      s('steps', { anchor: 'how-it-works' }),
      s('testimonials', c.testimonial?.quote ? { items: [it({ text: c.testimonial.quote, author: c.testimonial.author, role: c.testimonial.role })] } : {}),
      s('faq', {
        anchor: 'faq', items: [
          it({ title: 'How long does approval take?', text: 'Most applications are reviewed within one business day. You’ll get an email with your login link as soon as your workspace is active.' }),
          it({ title: 'Is there a free trial?', text: 'Yes — every new workspace receives free demo leads so you can try the platform before buying.' }),
          it({ title: 'Are leads shared with other businesses?', text: 'Leads delivered to your workspace are yours. Contact details stay private to your team.' }),
          it({ title: 'Can I invite my team?', text: 'Yes. Invite teammates, assign roles and share the pipeline.' }),
        ],
      }),
      s('cta', {}),
    ],
    footer: { text: `© ${new Date().getFullYear()} ${productName}. All rights reserved.` },
    seo: {},
  });
}

/** Where a link points: form anchor, sign-in or a URL. */
export function linkHref(l: Pick<HomeLink, 'action' | 'href'>) {
  return l.action === 'form' ? '#apply' : l.action === 'login' ? '/login' : l.href || '#';
}

/** Whether a homepage renders the form somewhere (hero with a form layout, or a form section). */
export function hasFormPlacement(h: Homepage) {
  return h.sections.some((s) => s.enabled && (s.type === 'form' || (s.type === 'hero' && (s.layout === 'form-right' || s.layout === 'form-left'))));
}
