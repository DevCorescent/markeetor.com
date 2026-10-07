import type { OnboardingForm, Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  CORE_KEYS, defaultFormConfig, emailDomain, formConfigSchema, isDisposableEmail, isFreeEmail, isVisible, LAYOUT_TYPES, URL_RE, validateAnswers, websiteDomain,
  type Answers, type FormConfig, type FormField,
} from '@/lib/onboarding';
import { audit } from '../audit';
import { buildContext, type AuthContext } from '../auth/context';
import { productName } from '../branding';
import { defaultHomepage, homepageSchema, type Homepage } from '@/lib/homepage';
import { withPlatform } from '../db';
import { getSetting, invalidateSetting } from '../settings';
import { AppError, notFound } from '../errors';
import { logger } from '../logger';
import { sendEmail } from '../mail';
import { fileExists, putBuffer, readStream, removeFile } from '../storage';
import { assertSafeSvg, sniffImage } from './branding';
import { criteriaSchema, topMatchIds } from './lead-finder';
import { billingSummary, createLeadRequest, getPricing } from './marketplace';
import { notifyPermission } from './notifications';
import { createOrganization } from './organizations';
import { recordReferral } from './client-tools';

/**
 * Business onboarding. Platform staff design public application forms; businesses apply; staff approve
 * (or the form auto-approves), which creates the workspace and emails the owner an invitation link.
 */

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'apply';
type Assets = { logo?: { v: number; type: string; ext: string; size: number } | null; cover?: { v: number; type: string; ext: string; size: number } | null };

const assetUrl = (slug: string, kind: 'logo' | 'cover', a: Assets[keyof Assets]) => (a ? `/api/v1/public/forms/${slug}/assets/${kind}?v=${a.v}` : null);

/** Ensures the fields the platform needs exist with the right types. */
function checkConfig(input: FormConfig) {
  // Re-validate here too: the service is also called outside the HTTP layer.
  const parsed = formConfigSchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Invalid form');
  const c = parsed.data;
  const byKey = new Map<string, FormField>();
  for (const f of c.fields) {
    if (LAYOUT_TYPES.includes(f.type)) continue;
    if (byKey.has(f.key)) throw new AppError('VALIDATION_FAILED', `Two fields use the key “${f.key}”`);
    byKey.set(f.key, f);
  }
  for (const k of CORE_KEYS) {
    const f = byKey.get(k);
    if (!f) throw new AppError('VALIDATION_FAILED', `The form needs a “${k}” field`);
    if (k === 'email' && f.type !== 'email') throw new AppError('VALIDATION_FAILED', 'The “email” field must be an email field');
    if (!f.required) throw new AppError('VALIDATION_FAILED', `The “${k}” field must be required`);
    if (f.showIf) throw new AppError('VALIDATION_FAILED', `The “${k}” field cannot be conditional`);
  }
  for (const f of c.fields) if (f.step >= c.steps.length) throw new AppError('VALIDATION_FAILED', `“${f.label || f.key}” is on a step that no longer exists`);
  return c;
}

// ── Admin: forms ───────────────────────────────────────────────────

export async function listForms() {
  const home = (await getSetting('homepage')).formId;
  return withPlatform(async (tx) => {
    const rows = await tx.onboardingForm.findMany({ orderBy: { updatedAt: 'desc' } });
    const counts = await tx.onboardingApplication.groupBy({ by: ['formId', 'status'], _count: true });
    return rows.map((f) => {
      const c = counts.filter((x) => x.formId === f.id);
      const sum = (s?: string) => c.filter((x) => !s || x.status === s).reduce((a, x) => a + x._count, 0);
      return { id: f.id, slug: f.slug, name: f.name, status: f.status, views: f.views, updatedAt: f.updatedAt, title: (f.config as FormConfig).content?.title, submissions: sum(), pending: sum('PENDING'), approved: sum('APPROVED'), isHomepage: f.id === home };
    });
  });
}

export async function createForm(ctx: AuthContext, input: { name: string; copyFrom?: string | null }) {
  return withPlatform(async (tx) => {
    let config = defaultFormConfig(await productName());
    if (input.copyFrom) {
      const src = await tx.onboardingForm.findUnique({ where: { id: input.copyFrom } });
      if (src) config = src.config as FormConfig;
    }
    const base = slugify(input.name);
    let slug = base;
    for (let i = 2; await tx.onboardingForm.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
    const f = await tx.onboardingForm.create({ data: { name: input.name, slug, config: config as unknown as Prisma.InputJsonValue, createdById: ctx.user.id } });
    await audit(tx, ctx, { action: 'onboarding.form.created', targetType: 'onboarding_form', targetId: f.id, organizationId: null, metadata: { name: f.name, slug } });
    return f;
  });
}

export async function getForm(id: string) {
  const f = await withPlatform((tx) => tx.onboardingForm.findUnique({ where: { id } }));
  if (!f) throw notFound('Form');
  const assets = f.assets as Assets;
  return { ...f, isHomepage: (await getSetting('homepage')).formId === f.id, assetUrls: { logo: assetUrl(f.slug, 'logo', assets.logo), cover: assetUrl(f.slug, 'cover', assets.cover) } };
}

export const saveFormInput = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().toLowerCase().min(2).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes'),
  status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED']),
  config: formConfigSchema,
});

export async function saveForm(ctx: AuthContext, id: string, input: z.infer<typeof saveFormInput>) {
  const config = checkConfig(input.config);
  return withPlatform(async (tx) => {
    const before = await tx.onboardingForm.findUnique({ where: { id } });
    if (!before) throw notFound('Form');
    const clash = await tx.onboardingForm.findUnique({ where: { slug: input.slug } });
    if (clash && clash.id !== id) throw new AppError('CONFLICT', `The address /join/${input.slug} is already used by another form`);
    const f = await tx.onboardingForm.update({ where: { id }, data: { name: input.name, slug: input.slug, status: input.status, config: config as unknown as Prisma.InputJsonValue } });
    await audit(tx, ctx, { action: 'onboarding.form.updated', targetType: 'onboarding_form', targetId: id, organizationId: null, before: { status: before.status, slug: before.slug }, after: { status: f.status, slug: f.slug } });
    return f;
  });
}

export async function deleteForm(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const f = await tx.onboardingForm.findUnique({ where: { id }, include: { _count: { select: { applications: true } } } });
    if (!f) throw notFound('Form');
    if (f._count.applications) {
      await tx.onboardingForm.update({ where: { id }, data: { status: 'CLOSED' } });
      return { deleted: false, closed: true };
    }
    await tx.onboardingForm.delete({ where: { id } });
    if ((await getSetting('homepage')).formId === id) {
      await tx.platformSetting.upsert({ where: { key: 'homepage' }, create: { key: 'homepage', value: { formId: null }, updatedById: ctx.user.id }, update: { value: { formId: null }, updatedById: ctx.user.id } });
      invalidateSetting('homepage');
    }
    await audit(tx, ctx, { action: 'onboarding.form.deleted', targetType: 'onboarding_form', targetId: id, organizationId: null, metadata: { name: f.name } });
    return { deleted: true, closed: false };
  });
}

// ── Site homepage ──────────────────────────────────────────────────

/** Serve this form's landing page at `/` (or stop, with null). Only published forms can be the homepage. */
export async function setHomepage(ctx: AuthContext, formId: string | null) {
  const before = (await getSetting('homepage')).formId;
  await withPlatform(async (tx) => {
    if (formId) {
      const f = await tx.onboardingForm.findUnique({ where: { id: formId } });
      if (!f) throw notFound('Form');
      if (f.status !== 'PUBLISHED') throw new AppError('PRECONDITION_FAILED', 'Publish the form before making it the homepage');
    }
    await tx.platformSetting.upsert({ where: { key: 'homepage' }, create: { key: 'homepage', value: { formId }, updatedById: ctx.user.id }, update: { value: { formId }, updatedById: ctx.user.id } });
    await audit(tx, ctx, { action: 'settings.homepage.updated', targetType: 'platform_setting', targetId: 'homepage', organizationId: null, before: { formId: before }, after: { formId } });
  });
  invalidateSetting('homepage');
  return { formId };
}

/** A form's landing page config, falling back to one generated from the form's content. */
export function homepageOf(c: FormConfig, product: string): Homepage {
  if (c.homepage) {
    const p = homepageSchema.safeParse(c.homepage);
    if (p.success) return p.data;
  }
  return defaultHomepage(c.content, product);
}

/** The landing page served at `/`, or null when no published (or closed) form is set as the homepage. */
export async function siteHomepage(opts: { countView?: boolean } = {}) {
  const id = (await getSetting('homepage')).formId;
  if (!id) return null;
  const f = await withPlatform((tx) => tx.onboardingForm.findUnique({ where: { id }, select: { slug: true, status: true } }));
  if (!f || f.status === 'DRAFT') return null;
  const form = await publicForm(f.slug, { countView: opts.countView });
  if (!form) return null;
  return { form, homepage: homepageOf(form.config as FormConfig, await productName()) };
}

/** Whether the public homepage Lead Finder may answer (the homepage is in finder mode, or staff previewing). */
export async function homeFinderSettings(ctx: AuthContext | null) {
  const home = await siteHomepage();
  const staff = Boolean(ctx?.permissions.has('onboarding.manage'));
  if (home?.homepage.mode === 'finder' || (home && staff)) return formFlags(home.form.slug);
  if (staff) return { autoApprove: false };
  return null;
}
async function formFlags(slug: string) {
  const f = await withPlatform((tx) => tx.onboardingForm.findUnique({ where: { slug }, select: { config: true } }));
  return { autoApprove: Boolean((f?.config as FormConfig | undefined)?.settings.autoApprove) };
}

/**
 * Welcome delivery: when the owner of a workspace created from an application accepts the invitation, the free
 * demo leads are requested for them from what they searched for (relaxing criteria if those leads are gone),
 * through the normal marketplace request flow — so pricing, approval policy, audit and billing all apply.
 */
export async function deliverWelcomeLeads(userId: string) {
  const ctx = await buildContext(userId, { requestId: `welcome:${userId}`, ip: null, userAgent: 'welcome-leads' }, null);
  const orgId = ctx.orgId;
  if (!orgId || ctx.scope !== 'ORGANIZATION') return null;
  // Claim the one-time delivery first so a retry can never deliver twice.
  const claim = await withPlatform(async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
    const settings = (org?.settings ?? {}) as Record<string, unknown>;
    const ob = settings.onboarding as { leadInterests?: { criteria?: unknown } | null; welcome?: unknown } | undefined;
    if (!ob?.leadInterests?.criteria || ob.welcome) return null;
    await tx.organization.update({ where: { id: orgId }, data: { settings: { ...settings, onboarding: { ...ob, welcome: { status: 'processing', at: new Date().toISOString() } } } as Prisma.InputJsonValue } });
    return ob.leadInterests.criteria;
  });
  if (!claim) return null;
  const mark = (welcome: Record<string, unknown>) => withPlatform(async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
    const settings = (org.settings ?? {}) as Record<string, unknown>;
    await tx.organization.update({ where: { id: orgId }, data: { settings: { ...settings, onboarding: { ...(settings.onboarding as object), welcome: { ...welcome, at: new Date().toISOString() } } } as Prisma.InputJsonValue } });
  });
  try {
    const p = await getPricing();
    const remaining = p.marketplaceEnabled ? (await billingSummary(ctx, orgId)).allowance.remaining : 0;
    const parsed = criteriaSchema.safeParse(claim);
    const ids = parsed.success ? await topMatchIds(parsed.data, remaining) : [];
    if (!ids.length) { await mark({ status: 'none', count: 0 }); return null; }
    const r = await createLeadRequest(ctx, { selection: { mode: 'ids', ids }, note: 'Welcome — free leads from your search', acceptCharges: false });
    const delivered = (r as { deliveredCount?: number }).deliveredCount ?? 0;
    await mark({ status: r.status, requestId: r.id, count: delivered || r.leadCount });
    return r;
  } catch (err) {
    logger.error({ err, orgId }, 'welcome lead delivery failed');
    await mark({ status: 'failed', count: 0 }).catch(() => null);
    return null;
  }
}

// ── Assets (logo / cover image) ────────────────────────────────────

const LIMIT = { logo: 1024 * 1024, cover: 5 * 1024 * 1024 } as const;
const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const EXT: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', svg: 'svg' };
const keyFor = (formId: string, kind: string, a: { v: number; ext: string }) => `onboarding/${formId}-${kind}-${a.v}.${a.ext}`;

export async function uploadFormAsset(ctx: AuthContext, formId: string, kind: 'logo' | 'cover', buf: Buffer) {
  if (buf.length > LIMIT[kind]) throw new AppError('PAYLOAD_TOO_LARGE', `Images are limited to ${LIMIT[kind] / 1024 / 1024} MB`);
  const t = sniffImage(buf);
  if (!t || !(t in MIME)) throw new AppError('UNSUPPORTED_MEDIA', 'Upload a PNG, JPEG, WEBP or SVG image');
  if (t === 'svg') assertSafeSvg(buf);
  const f = await withPlatform((tx) => tx.onboardingForm.findUnique({ where: { id: formId } }));
  if (!f) throw notFound('Form');
  const assets = f.assets as Assets;
  const next = { v: Date.now(), type: MIME[t], ext: EXT[t], size: buf.length };
  await putBuffer(keyFor(formId, kind, next), buf);
  await withPlatform(async (tx) => {
    await tx.onboardingForm.update({ where: { id: formId }, data: { assets: { ...assets, [kind]: next } as Prisma.InputJsonValue } });
    await audit(tx, ctx, { action: 'onboarding.form.asset', targetType: 'onboarding_form', targetId: formId, organizationId: null, metadata: { kind } });
  });
  const old = assets[kind];
  if (old) await removeFile(keyFor(formId, kind, old)).catch(() => null);
  return assetUrl(f.slug, kind, next);
}

export async function removeFormAsset(formId: string, kind: 'logo' | 'cover') {
  const f = await withPlatform((tx) => tx.onboardingForm.findUnique({ where: { id: formId } }));
  if (!f) throw notFound('Form');
  const assets = f.assets as Assets;
  const old = assets[kind];
  await withPlatform((tx) => tx.onboardingForm.update({ where: { id: formId }, data: { assets: { ...assets, [kind]: null } as Prisma.InputJsonValue } }));
  if (old) await removeFile(keyFor(formId, kind, old)).catch(() => null);
}

export async function openFormAsset(slug: string, kind: 'logo' | 'cover') {
  const f = await withPlatform((tx) => tx.onboardingForm.findUnique({ where: { slug } }));
  const a = f ? (f.assets as Assets)[kind] : null;
  if (!f || !a || !(await fileExists(keyFor(f.id, kind, a)))) return null;
  return { asset: a, stream: readStream(keyFor(f.id, kind, a)) };
}

// ── Public ─────────────────────────────────────────────────────────

/** Why a form cannot take submissions right now (null = open). */
async function closedReason(f: OnboardingForm) {
  const c = f.config as FormConfig;
  if (f.status !== 'PUBLISHED') return f.status === 'CLOSED' ? c.settings.closedMessage : 'This form is not published yet.';
  if (c.settings.closesAt && new Date(c.settings.closesAt) < new Date()) return c.settings.closedMessage;
  if (c.settings.maxSubmissions != null) {
    const n = await withPlatform((tx) => tx.onboardingApplication.count({ where: { formId: f.id, status: { not: 'SPAM' } } }));
    if (n >= c.settings.maxSubmissions) return c.settings.closedMessage;
  }
  return null;
}

/** What the public page needs — never internal settings like activation quotas. */
export async function publicForm(slug: string, opts: { preview?: boolean; countView?: boolean } = {}) {
  const f = await withPlatform((tx) => tx.onboardingForm.findUnique({ where: { slug } }));
  if (!f || (f.status === 'DRAFT' && !opts.preview)) return null;
  if (opts.countView && !opts.preview) await withPlatform((tx) => tx.onboardingForm.update({ where: { id: f.id }, data: { views: { increment: 1 } } })).catch(() => null);
  const c = f.config as FormConfig;
  const assets = f.assets as Assets;
  const { activation: _a, autoApprove: _b, notifyAdmins: _c, ...settings } = c.settings;
  return {
    slug: f.slug, name: f.name, closed: opts.preview ? null : await closedReason(f),
    config: { ...c, settings },
    assets: { logo: assetUrl(f.slug, 'logo', assets.logo), cover: assetUrl(f.slug, 'cover', assets.cover) },
  };
}
export type PublicForm = NonNullable<Awaited<ReturnType<typeof publicForm>>>;

export const submitInput = z.object({
  answers: z.record(z.string().max(40), z.union([z.string().max(5000), z.array(z.string().max(200)).max(50), z.boolean(), z.number(), z.null()])),
  startedAt: z.number().int().optional(),
  leadInterests: z.object({ criteria: criteriaSchema, summary: z.string().max(500).optional(), matches: z.number().int().min(0).optional() }).nullable().optional(),
  hp: z.string().max(500).optional(), // honeypot: a hidden field real people never fill
  ref: z.string().trim().max(20).regex(/^[A-Za-z0-9]*$/).optional(), // referral code from /join?ref=
});

export async function submitApplication(slug: string, input: z.infer<typeof submitInput>, meta: { ip: string | null; userAgent: string | null }) {
  const f = await withPlatform((tx) => tx.onboardingForm.findUnique({ where: { slug } }));
  if (!f) throw notFound('Form');
  const reason = await closedReason(f);
  if (reason) throw new AppError('CONFLICT', reason);
  const c = f.config as FormConfig;
  const { errors, clean } = validateAnswers(c, input.answers as Answers);
  if (c.settings.leadFinder.enabled && c.settings.leadFinder.required && !input.leadInterests) errors._leadFinder = 'Tell us what leads you are looking for';
  const email = String(clean.email ?? '').toLowerCase();
  if (email && !errors.email) {
    if (c.settings.blockDisposable && isDisposableEmail(email)) errors.email = 'Please use a permanent email address';
    else if (c.settings.requireBusinessEmail && isFreeEmail(email)) errors.email = 'Please use your work email address';
  }
  if (Object.keys(errors).length) throw new AppError('VALIDATION_FAILED', 'Please check the highlighted fields', { fields: errors });

  // Silent spam handling: bots get a normal-looking success but nothing reaches the review queue.
  const elapsed = input.startedAt != null ? Date.now() - input.startedAt : null;
  const tooFast = elapsed != null && c.settings.minSeconds > 0 && elapsed < c.settings.minSeconds * 1000;
  const spam = Boolean(input.hp) || (elapsed != null && elapsed < 1500);

  const domain = emailDomain(email);
  const site = typeof clean.website === 'string' ? websiteDomain(clean.website) : '';
  const flags: string[] = [];
  if (isFreeEmail(email)) flags.push('free_email');
  if (site && domain && !isFreeEmail(email) && site !== domain && !site.endsWith(`.${domain}`) && !domain.endsWith(`.${site}`)) flags.push('website_mismatch');
  if (tooFast) flags.push('fast_submit');
  const [dupOrg, dupApp, dupUser] = await withPlatform((tx) => Promise.all([
    tx.organization.findFirst({ where: { OR: [{ contactEmail: { equals: email, mode: 'insensitive' } }, ...(site ? [{ website: { contains: site, mode: 'insensitive' as const } }] : [])] }, select: { id: true } }),
    tx.onboardingApplication.findFirst({ where: { email, status: { in: ['PENDING', 'APPROVED'] } }, select: { id: true } }),
    tx.user.findUnique({ where: { email }, select: { id: true } }),
  ]));
  if (dupOrg) flags.push('existing_client');
  if (dupApp) flags.push('duplicate_application');
  if (dupUser) flags.push('existing_user');

  // Quality: how complete and credible the application is (0–100).
  const answerable = c.fields.filter((x) => !LAYOUT_TYPES.includes(x.type) && x.type !== 'consent' && isVisible(x, clean));
  const filled = answerable.filter((x) => clean[x.key] != null && clean[x.key] !== '').length;
  let quality = Math.round((filled / Math.max(1, answerable.length)) * 40);
  if (!isFreeEmail(email)) quality += 25;
  if (site) quality += 10;
  if (clean.phone) quality += 10;
  if (input.leadInterests) quality += 10;
  if (!flags.some((x) => ['website_mismatch', 'duplicate_application', 'existing_client', 'fast_submit'].includes(x))) quality += 5;

  const app = await withPlatform((tx) => tx.onboardingApplication.create({
    data: {
      formId: f.id, status: spam ? 'SPAM' : 'PENDING',
      businessName: String(clean.businessName ?? '').slice(0, 200), contactName: String(clean.contactName ?? '').slice(0, 120), email,
      phone: clean.phone ? String(clean.phone).slice(0, 40) : null, website: typeof clean.website === 'string' ? clean.website.slice(0, 300) : null,
      industry: clean.industry ? String(clean.industry).slice(0, 80) : null, country: clean.country ? String(clean.country).slice(0, 80) : null,
      answers: (input.ref ? { ...clean, _ref: input.ref.toUpperCase() } : clean) as Prisma.InputJsonValue, leadInterests: (input.leadInterests ?? undefined) as Prisma.InputJsonValue | undefined,
      flags, quality: Math.min(100, quality), ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) ?? null,
    },
  }));
  if (spam) return { ok: true, id: app.id };
  await import('./endpoints').then((m) => m.emitEmailEvent('onboarding.submitted', {
    application: { id: app.id, businessName: app.businessName, contactName: app.contactName, email: app.email, phone: app.phone, website: app.website, industry: app.industry, country: app.country, quality: app.quality, flags: app.flags },
    form: { name: f.name },
  }, app.id)).catch(() => null);

  if (c.settings.sendConfirmation) {
    await sendEmail({
      to: email,
      subject: `We received your application — ${await productName()}`,
      body: `Hi ${app.contactName},\n\n${c.settings.confirmationMessage || `Thanks for applying for a ${await productName()} workspace for ${app.businessName}. Our team reviews every application and you will receive your login link as soon as your workspace is activated.`}\n`,
    }).catch((err) => logger.warn({ err }, 'confirmation email failed'));
  }
  if (c.settings.autoApprove && !flags.includes('existing_user') && !flags.includes('existing_client')) {
    try {
      const creator = await buildContext(f.createdById, { requestId: `onboarding:${app.id}`, ip: meta.ip, userAgent: 'auto-approve' }, null);
      await approveApplication(creator, app.id, {});
      return { ok: true, id: app.id, activated: true };
    } catch (err) {
      logger.warn({ err, application: app.id }, 'auto-approval failed; left for review');
    }
  }
  if (c.settings.notifyAdmins) {
    await notifyPermission('onboarding.manage', null, { type: 'ONBOARDING', title: `New application: ${app.businessName}`, body: `${app.contactName} · ${email}${flags.length ? ` · ${flags.join(', ')}` : ''}`, link: `/admin/onboarding?tab=applications&id=${app.id}` });
  }
  return { ok: true, id: app.id, activated: false };
}

// ── Admin: applications ────────────────────────────────────────────

export async function listApplications(params: { status?: string; formId?: string; q?: string; page: number; pageSize: number }) {
  return withPlatform(async (tx) => {
    const where: Prisma.OnboardingApplicationWhereInput = {
      ...(params.status ? { status: params.status } : { status: { not: 'SPAM' } }),
      ...(params.formId ? { formId: params.formId } : {}),
      ...(params.q ? { OR: [{ businessName: { contains: params.q, mode: 'insensitive' } }, { email: { contains: params.q.toLowerCase() } }, { contactName: { contains: params.q, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows, counts] = await Promise.all([
      tx.onboardingApplication.count({ where }),
      tx.onboardingApplication.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize, include: { form: { select: { name: true, slug: true } } } }),
      tx.onboardingApplication.groupBy({ by: ['status'], _count: true, ...(params.formId ? { where: { formId: params.formId } } : {}) }),
    ]);
    return { total, rows, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
  });
}

export async function getApplication(id: string) {
  const a = await withPlatform((tx) => tx.onboardingApplication.findUnique({ where: { id }, include: { form: true } }));
  if (!a) throw notFound('Application');
  const org = a.organizationId ? await withPlatform((tx) => tx.organization.findUnique({ where: { id: a.organizationId! }, select: { id: true, name: true, code: true, status: true } })) : null;
  const labels = Object.fromEntries((a.form.config as FormConfig).fields.map((f) => [f.key, f.label || f.key]));
  return { ...a, form: { id: a.form.id, name: a.form.name, slug: a.form.slug, activation: (a.form.config as FormConfig).settings.activation }, labels, organization: org };
}

export const approveInput = z.object({
  businessName: z.string().trim().min(2).max(120).optional(),
  ownerName: z.string().trim().min(2).max(120).optional(),
  ownerEmail: z.string().trim().email().max(254).optional(),
  maxUsers: z.number().int().min(1).max(10_000).optional(),
  maxActiveLeads: z.number().int().min(0).max(10_000_000).optional(),
  dailyAllocationLimit: z.number().int().min(0).max(1_000_000).optional(),
  monthlyAllocationLimit: z.number().int().min(0).max(10_000_000).optional(),
  note: z.string().trim().max(500).optional(),
});

export async function approveApplication(ctx: AuthContext, id: string, input: z.infer<typeof approveInput>) {
  const a = await withPlatform((tx) => tx.onboardingApplication.findUnique({ where: { id }, include: { form: true } }));
  if (!a) throw notFound('Application');
  if (a.status === 'APPROVED') throw new AppError('CONFLICT', 'This application was already approved');
  const act = (a.form.config as FormConfig).settings.activation;
  const website = a.website && URL_RE.test(a.website) ? a.website : null;
  const res = await createOrganization(ctx, {
    name: input.businessName ?? a.businessName, industry: a.industry, website, contactEmail: a.email, contactPhone: a.phone,
    owner: { name: input.ownerName ?? a.contactName, email: input.ownerEmail ?? a.email },
    quota: {
      maxUsers: input.maxUsers ?? act.maxUsers, maxActiveLeads: input.maxActiveLeads ?? act.maxActiveLeads,
      dailyAllocationLimit: input.dailyAllocationLimit ?? act.dailyAllocationLimit, monthlyAllocationLimit: input.monthlyAllocationLimit ?? act.monthlyAllocationLimit,
      ...(a.industry ? { industries: [a.industry] } : {}), ...(a.country ? { regions: [a.country] } : {}),
    },
  });
  return withPlatform(async (tx) => {
    // Remember what they told us (incl. Lead Finder interests) on the workspace for later personalisation.
    const settings = (await tx.organization.findUniqueOrThrow({ where: { id: res.org.id }, select: { settings: true } })).settings as Record<string, unknown>;
    await tx.organization.update({ where: { id: res.org.id }, data: { settings: { ...settings, onboarding: { applicationId: a.id, formId: a.formId, answers: a.answers, leadInterests: a.leadInterests } } as Prisma.InputJsonValue } });
    const updated = await tx.onboardingApplication.update({ where: { id }, data: { status: 'APPROVED', organizationId: res.org.id, decidedById: ctx.user.id, decidedAt: new Date(), notes: input.note ?? a.notes } });
    await audit(tx, ctx, { action: 'onboarding.application.approved', targetType: 'onboarding_application', targetId: id, organizationId: res.org.id, metadata: { business: a.businessName, email: a.email, org: res.org.code } });
    return { application: updated, organization: { id: res.org.id, name: res.org.name, code: res.org.code }, inviteSentTo: res.invite?.email ?? null };
  }).then(async (out) => {
    // Referral code captured from /join?ref=… on the application.
    const ref = (a.answers as Record<string, unknown> | null)?._ref;
    if (typeof ref === 'string') await recordReferral(res.org.id, ref).catch(() => null);
    return out;
  });
}

export async function rejectApplication(ctx: AuthContext, id: string, input: { reason: string; notify: boolean; spam?: boolean }) {
  const a = await withPlatform((tx) => tx.onboardingApplication.findUnique({ where: { id } }));
  if (!a) throw notFound('Application');
  if (a.status === 'APPROVED') throw new AppError('CONFLICT', 'Approved applications cannot be rejected — suspend the workspace instead');
  const updated = await withPlatform(async (tx) => {
    const u = await tx.onboardingApplication.update({ where: { id }, data: { status: input.spam ? 'SPAM' : 'REJECTED', reason: input.reason, decidedById: ctx.user.id, decidedAt: new Date() } });
    await audit(tx, ctx, { action: input.spam ? 'onboarding.application.spam' : 'onboarding.application.rejected', targetType: 'onboarding_application', targetId: id, organizationId: null, reason: input.reason });
    return u;
  });
  if (input.notify && !input.spam) {
    await sendEmail({ to: a.email, subject: `Your application to ${await productName()}`, body: `Hi ${a.contactName},\n\nThank you for your interest. We're unable to approve the application for ${a.businessName} at this time.\n\n${input.reason}\n` }).catch(() => null);
  }
  return updated;
}

export async function noteApplication(ctx: AuthContext, id: string, notes: string) {
  return withPlatform(async (tx) => {
    const u = await tx.onboardingApplication.update({ where: { id }, data: { notes } });
    await audit(tx, ctx, { action: 'onboarding.application.noted', targetType: 'onboarding_application', targetId: id, organizationId: null });
    return u;
  });
}

/** Funnel-style numbers for the onboarding overview. */
export async function onboardingStats() {
  return withPlatform(async (tx) => {
    const [views, byStatus, recent] = await Promise.all([
      tx.onboardingForm.aggregate({ _sum: { views: true } }),
      tx.onboardingApplication.groupBy({ by: ['status'], _count: true }),
      tx.onboardingApplication.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 86400_000) }, status: { not: 'SPAM' } } }),
    ]);
    const s = Object.fromEntries(byStatus.map((b) => [b.status, b._count]));
    const submitted = (s.PENDING ?? 0) + (s.APPROVED ?? 0) + (s.REJECTED ?? 0);
    return { views: views._sum.views ?? 0, submitted, pending: s.PENDING ?? 0, approved: s.APPROVED ?? 0, rejected: s.REJECTED ?? 0, spam: s.SPAM ?? 0, lastWeek: recent };
  });
}

export { validateAnswers };
