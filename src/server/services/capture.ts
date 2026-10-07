import { randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { formConfigSchema, type FormConfig } from '@/lib/marketing';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { withPlatform, withTenant } from '../db';
import { AppError, notFound } from '../errors';
import { validateUrl } from '../enrichment/fetch';
import { assertClean, assertFeature, getMarketing, leadFromToken } from './marketing';
import { normalizeEmail, normalizePhone } from './normalize';
import { notifyPermission } from './notifications';

/**
 * Tracked links (short URLs with click counts, per-lead attribution and QR codes) and lead-capture forms
 * (hosted at /f/<slug> or embedded with an iframe). A submission becomes a lead in the workspace: a master
 * lead marked as client-captured (allocated straight to the workspace, never sold), its assignment and the
 * workspace's working copy — then auto-assignment, consent and the form's follow-up sequence.
 */

const code = () => randomBytes(5).toString('base64url').replace(/[-_]/g, '').slice(0, 7) || randomBytes(4).toString('hex');

// ── Links ──────────────────────────────────────────────────────────

export const linkInput = z.object({
  name: z.string().trim().min(2).max(120),
  url: z.string().trim().url().max(1000),
  utmSource: z.string().trim().max(60).optional(), utmMedium: z.string().trim().max(60).optional(), utmCampaign: z.string().trim().max(80).optional(),
});

export async function listLinks(ctx: AuthContext) {
  await assertFeature(ctx, 'links');
  return withPlatform((tx) => tx.trackedLink.findMany({ where: { organizationId: ctx.orgId! }, orderBy: { createdAt: 'desc' } }));
}

export async function createLink(ctx: AuthContext, input: z.infer<typeof linkInput>) {
  const s = await assertFeature(ctx, 'links');
  try { validateUrl(input.url); } catch { throw new AppError('VALIDATION_FAILED', 'Enter a public http(s) web address'); }
  assertClean(input.url, s);
  return withPlatform(async (tx) => {
    if ((await tx.trackedLink.count({ where: { organizationId: ctx.orgId! } })) >= s.limits.links) throw new AppError('CONFLICT', `You can have up to ${s.limits.links} tracked links`);
    let c = code();
    while (await tx.trackedLink.findUnique({ where: { code: c } })) c = code();
    return tx.trackedLink.create({ data: { organizationId: ctx.orgId!, code: c, name: input.name, url: input.url, utmSource: input.utmSource || null, utmMedium: input.utmMedium || null, utmCampaign: input.utmCampaign || null, createdById: ctx.user.id } });
  });
}

export async function deleteLink(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const l = await tx.trackedLink.findUnique({ where: { id } });
    if (!l || l.organizationId !== ctx.orgId) throw notFound('Link');
    await tx.trackedLink.delete({ where: { id } });
    return { ok: true };
  });
}

/** Public redirect: records the click (and the lead, from a signed token) and returns the destination with UTM tags. */
export async function resolveLink(c: string, meta: { token?: string | null; referer?: string | null; userAgent?: string | null }) {
  const l = await withPlatform((tx) => tx.trackedLink.findUnique({ where: { code: c } }));
  if (!l) return null;
  const clientLeadId = leadFromToken(meta.token);
  const isBot = /bot|crawler|spider|preview|facebookexternalhit|whatsapp|slackbot|telegram/i.test(meta.userAgent ?? '');
  if (!isBot) {
    await withPlatform(async (tx) => {
      const firstForLead = clientLeadId ? !(await tx.linkClick.findFirst({ where: { linkId: l.id, clientLeadId }, select: { id: true } })) : false;
      await tx.linkClick.create({ data: { linkId: l.id, organizationId: l.organizationId, clientLeadId, referer: meta.referer?.slice(0, 300) ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null } });
      await tx.trackedLink.update({ where: { id: l.id }, data: { clicks: { increment: 1 }, lastClickAt: new Date(), ...(firstForLead ? { uniqueLeads: { increment: 1 } } : {}) } });
      if (clientLeadId) {
        const lead = await tx.clientLead.findFirst({ where: { id: clientLeadId, organizationId: l.organizationId }, select: { id: true, leadId: true } });
        if (lead) await tx.activity.create({ data: { organizationId: l.organizationId, clientLeadId: lead.id, leadId: lead.leadId, type: 'LINK_CLICKED', verification: 'SYSTEM_VERIFIED', summary: `Clicked “${l.name}”`, data: { linkId: l.id } } });
      }
    }).catch(() => null);
  }
  const u = new URL(l.url);
  if (l.utmSource && !u.searchParams.has('utm_source')) u.searchParams.set('utm_source', l.utmSource);
  if (l.utmMedium && !u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', l.utmMedium);
  if (l.utmCampaign && !u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', l.utmCampaign);
  return u.toString();
}

export async function linkQr(ctx: AuthContext, id: string) {
  const l = await withPlatform((tx) => tx.trackedLink.findUnique({ where: { id } }));
  if (!l || l.organizationId !== ctx.orgId) throw notFound('Link');
  const QR = await import('qrcode');
  const url = `${process.env.APP_URL ?? ''}/l/${l.code}`;
  return { url, svg: await QR.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
}

// ── Forms ──────────────────────────────────────────────────────────

export const formInput = z.object({ name: z.string().trim().min(2).max(120), config: formConfigSchema, sequenceId: z.string().max(64).nullable().default(null), status: z.enum(['ACTIVE', 'PAUSED']).default('ACTIVE') });

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'form';

export async function listForms(ctx: AuthContext) {
  await assertFeature(ctx, 'forms');
  return withPlatform((tx) => tx.captureForm.findMany({ where: { organizationId: ctx.orgId! }, orderBy: { createdAt: 'desc' } }));
}

export async function saveForm(ctx: AuthContext, id: string | null, input: z.infer<typeof formInput>) {
  const s = await assertFeature(ctx, 'forms');
  assertClean(`${input.config.title} ${input.config.description} ${input.config.thankYou}`, s);
  if (!input.config.fields.some((f) => f.mapTo === 'email' || f.mapTo === 'phone')) throw new AppError('VALIDATION_FAILED', 'Add an email or phone field so you can follow up');
  if (input.config.redirectUrl) { try { validateUrl(input.config.redirectUrl); } catch { throw new AppError('VALIDATION_FAILED', 'Redirect must be a public web address'); } }
  return withPlatform(async (tx) => {
    if (input.sequenceId && !(await tx.sequence.findFirst({ where: { id: input.sequenceId, organizationId: ctx.orgId! } }))) throw notFound('Sequence');
    if (id) {
      const f = await tx.captureForm.findUnique({ where: { id } });
      if (!f || f.organizationId !== ctx.orgId) throw notFound('Form');
      const status = f.status === 'PENDING_REVIEW' || f.status === 'REJECTED' ? (s.moderation.reviewForms ? 'PENDING_REVIEW' : input.status) : input.status;
      return tx.captureForm.update({ where: { id }, data: { name: input.name, config: input.config as Prisma.InputJsonValue, sequenceId: input.sequenceId, status } });
    }
    if ((await tx.captureForm.count({ where: { organizationId: ctx.orgId! } })) >= s.limits.forms) throw new AppError('CONFLICT', `You can have up to ${s.limits.forms} forms`);
    let slug = `${slugify(input.name)}-${code().toLowerCase().slice(0, 4)}`;
    while (await tx.captureForm.findUnique({ where: { slug } })) slug = `${slugify(input.name)}-${code().toLowerCase().slice(0, 5)}`;
    const f = await tx.captureForm.create({ data: { organizationId: ctx.orgId!, slug, name: input.name, config: input.config as Prisma.InputJsonValue, sequenceId: input.sequenceId, status: s.moderation.reviewForms ? 'PENDING_REVIEW' : input.status, createdById: ctx.user.id } });
    await audit(tx, ctx, { action: 'marketing.form.created', targetType: 'capture_form', targetId: f.id, metadata: { name: f.name, slug } });
    if (f.status === 'PENDING_REVIEW') await notifyPermission('email.manage', null, { type: 'MARKETING_REVIEW', title: `New lead form to review: ${f.name}`, body: ctx.org?.name ?? '', link: '/admin/marketing?tab=moderation' }, tx);
    return f;
  });
}

export async function deleteForm(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const f = await tx.captureForm.findUnique({ where: { id } });
    if (!f || f.organizationId !== ctx.orgId) throw notFound('Form');
    await tx.captureForm.delete({ where: { id } });
    return { ok: true };
  });
}

export async function reviewForm(ctx: AuthContext, id: string, approve: boolean, note?: string) {
  return withPlatform(async (tx) => {
    const f = await tx.captureForm.findUnique({ where: { id } });
    if (!f) throw notFound('Form');
    const u = await tx.captureForm.update({ where: { id }, data: { status: approve ? 'ACTIVE' : 'REJECTED', reviewNote: note ?? null } });
    await audit(tx, ctx, { action: `marketing.form.${approve ? 'approved' : 'rejected'}`, targetType: 'capture_form', targetId: id, organizationId: f.organizationId, reason: note });
    await notifyPermission('crm.email.manage', f.organizationId, { type: 'MARKETING_REVIEW', title: `Form “${f.name}” was ${approve ? 'approved — it is live' : 'not approved'}`, body: note ?? '', link: '/app/marketing?tab=forms' }, tx);
    return u;
  });
}

/** Public: the form as visitors see it (counts a view). */
export async function publicCaptureForm(slug: string, opts: { countView?: boolean } = {}) {
  const f = await withPlatform((tx) => tx.captureForm.findUnique({ where: { slug } }));
  if (!f || f.status !== 'ACTIVE') return null;
  const s = await getMarketing();
  if (!s.enabled) return null;
  if (opts.countView) await withPlatform((tx) => tx.captureForm.update({ where: { id: f.id }, data: { views: { increment: 1 } } })).catch(() => null);
  const org = await withPlatform((tx) => tx.organization.findUnique({ where: { id: f.organizationId }, select: { name: true, status: true } }));
  if (!org || org.status !== 'ACTIVE') return null;
  return { slug: f.slug, name: f.name, organization: org.name, config: f.config as FormConfig };
}

export const submitCapture = z.object({
  answers: z.record(z.string().max(40), z.string().max(4000)),
  consent: z.boolean().default(false),
  hp: z.string().max(200).optional(),
  utm: z.record(z.string().max(20), z.string().max(200)).optional(),
  startedAt: z.number().int().optional(),
});

export async function submitCaptureForm(slug: string, input: z.infer<typeof submitCapture>, meta: { ip: string | null }) {
  const f = await withPlatform((tx) => tx.captureForm.findUnique({ where: { slug } }));
  if (!f || f.status !== 'ACTIVE') throw notFound('Form');
  const cfg = f.config as FormConfig;
  // Bots: silently accepted, nothing created.
  if (input.hp || (input.startedAt != null && Date.now() - input.startedAt < 1500)) return { ok: true, thankYou: cfg.thankYou, redirectUrl: cfg.redirectUrl };
  const errors: Record<string, string> = {};
  const val: Record<string, string> = {};
  for (const fld of cfg.fields) {
    const v = (input.answers[fld.key] ?? '').trim();
    if (fld.required && !v) { errors[fld.key] = 'Required'; continue; }
    if (v && fld.type === 'email' && !normalizeEmail(v).value) errors[fld.key] = 'Enter a valid email';
    if (v && fld.type === 'phone' && !normalizePhone(v, 'IN').value) errors[fld.key] = 'Enter a valid phone number';
    if (v && fld.type === 'select' && fld.options.length && !fld.options.includes(v)) errors[fld.key] = 'Choose an option';
    val[fld.key] = v.slice(0, 2000);
  }
  if (Object.keys(errors).length) throw new AppError('VALIDATION_FAILED', 'Please check the highlighted fields', { fields: errors });
  const pick = (m: string) => cfg.fields.filter((x) => x.mapTo === m).map((x) => val[x.key]).find(Boolean) ?? null;
  const email = normalizeEmail(pick('email')).value;
  const phone = normalizePhone(pick('phone'), 'IN').value;
  const fullName = pick('fullName') || email?.split('@')[0] || phone || 'Website visitor';
  const custom = Object.fromEntries(cfg.fields.filter((x) => x.mapTo === 'custom').map((x) => [x.key, val[x.key]]).filter(([, v]) => v));
  const note = pick('note');

  const created = await withPlatform(async (tx) => {
    // Same email/phone already in this workspace: record the submission on that lead instead of duplicating it.
    const existing = email || phone ? await tx.clientLead.findFirst({ where: { organizationId: f.organizationId, revokedAt: null, OR: [...(email ? [{ email: { equals: email, mode: 'insensitive' as const } }] : []), ...(phone ? [{ phone }] : [])] }, select: { id: true, leadId: true } }) : null;
    let clientLeadId = existing?.id;
    let leadId = existing?.leadId;
    if (!clientLeadId) {
      leadId = randomUUID();
      const assignmentId = randomUUID();
      const stage = await tx.pipelineStage.findFirst({ where: { organizationId: f.organizationId, pipeline: { isDefault: true } }, orderBy: { position: 'asc' }, select: { id: true, pipelineId: true } });
      const base = { fullName: fullName.slice(0, 200), email: email ?? null, phone: phone ?? null, company: pick('company'), jobTitle: pick('jobTitle'), city: pick('city'), source: 'Lead form', campaign: f.name, customFields: custom as Prisma.InputJsonValue };
      await tx.lead.create({ data: { id: leadId, ...base, emailNormalized: email, phoneNormalized: phone, allocationStatus: 'ALLOCATED', assignedOrganizationId: f.organizationId, clientStatus: 'NEW', distributionCount: 1, lastDistributedAt: new Date() } });
      await tx.leadAssignment.create({ data: { id: assignmentId, leadId, organizationId: f.organizationId, assignedById: f.createdById, status: 'ACTIVE' } });
      const cl = await tx.clientLead.create({ data: { ...base, organizationId: f.organizationId, leadId, assignmentId, status: 'NEW', pipelineId: stage?.pipelineId ?? null, stageId: stage?.id ?? null, stageEnteredAt: new Date() } });
      clientLeadId = cl.id;
    }
    await tx.activity.create({ data: { organizationId: f.organizationId, clientLeadId, leadId, type: 'FORM_SUBMITTED', verification: 'SYSTEM_VERIFIED', summary: `Submitted form “${f.name}”`, data: { formId: f.id, utm: input.utm ?? null } } });
    if (note) await tx.note.create({ data: { organizationId: f.organizationId, clientLeadId: clientLeadId!, authorId: f.createdById, body: `Form “${f.name}”: ${note.slice(0, 2000)}` } }).catch(() => null);
    if (input.consent && cfg.consent) {
      for (const ch of ['EMAIL', 'WHATSAPP', 'SMS'] as const) await tx.consentRecord.create({ data: { organizationId: f.organizationId, clientLeadId: clientLeadId!, channel: ch, status: 'OPTED_IN', source: `Form “${f.name}”`, recordedById: f.createdById } });
    }
    await tx.captureSubmission.create({ data: { organizationId: f.organizationId, formId: f.id, clientLeadId, data: val as Prisma.InputJsonValue, utm: (input.utm ?? undefined) as Prisma.InputJsonValue | undefined } });
    await tx.captureForm.update({ where: { id: f.id }, data: { submissions: { increment: 1 } } });
    return { clientLeadId: clientLeadId!, isNew: !existing };
  });

  if (created.isNew) {
    const { autoAssign } = await import('./workspace-automation');
    await autoAssign(f.organizationId, [created.clientLeadId]).catch(() => null);
  }
  if (f.sequenceId) {
    const { enroll } = await import('./sequences');
    await enroll(null, f.sequenceId, { clientLeadIds: [created.clientLeadId] }, { orgId: f.organizationId, actorId: f.createdById }).catch(() => null);
  }
  await notifyPermission('crm.leads.assign', f.organizationId, { type: 'FORM_SUBMITTED', title: `New lead from “${f.name}”`, body: fullName, link: `/app/leads/${created.clientLeadId}` }).catch(() => null);
  void meta;
  return { ok: true, thankYou: cfg.thankYou, redirectUrl: cfg.redirectUrl };
}

export async function formSubmissions(ctx: AuthContext, formId: string) {
  const f = await withPlatform((tx) => tx.captureForm.findUnique({ where: { id: formId } }));
  if (!f || f.organizationId !== ctx.orgId) throw notFound('Form');
  const rows = await withTenant(ctx.orgId!, (tx) => tx.captureSubmission.findMany({ where: { formId }, orderBy: { createdAt: 'desc' }, take: 100 }));
  return { form: f, rows };
}
