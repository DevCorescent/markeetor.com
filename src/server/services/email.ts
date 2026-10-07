import { Prisma, type EmailMessage, type SmtpAccount } from '@prisma/client';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';
import { selectionSchema, filterSchema, type Selection } from '@/lib/filters';
import { maskEmail } from '@/lib/mask';
import { renderEmail } from '@/lib/email/render';
import type { Block, EmailDesign, Variables } from '@/lib/email/types';
import { audit } from '../audit';
import { can, type AuthContext } from '../auth/context';
import { decrypt, encrypt, randomToken, sha256 } from '../crypto';
import { prisma, withPlatform, withTenant, type Tx } from '../db';
import { AppError, notFound } from '../errors';
import { enqueue } from '../jobs/queues';
import { logger } from '../logger';
import { rateLimit } from '../ratelimit';
import { ACTIVITY } from './activity';
import { buildClientLeadWhere } from './lead-filters';
import { resolveLeadSelection } from './leads';
import { normalizeEmail } from './normalize';
import { notifyUsers } from './notifications';
import { productName } from '../branding';
import { bulkHeaders, trackingAllowed, transportExtras } from './deliverability';
import { recordMessageEvent } from './email-events';

/**
 * Email: SMTP sender accounts (platform + per workspace), block-designed templates, campaigns with a
 * per-recipient delivery log, open tracking and unsubscribe handling.
 *
 * Scope rule: the caller's scope decides the tenant. Platform users work with organizationId = null
 * rows and master leads; workspace users only ever see their organization's rows (RLS-enforced).
 */

const scopeDb = <T,>(ctx: AuthContext, fn: (tx: Tx) => Promise<T>, timeout = 30_000) =>
  ctx.scope === 'PLATFORM' ? withPlatform(fn, { timeout }) : withTenant(ctx.orgId!, fn, { timeout });
const orgOf = (ctx: AuthContext) => (ctx.scope === 'PLATFORM' ? null : ctx.orgId!);

// ── Sanitization & design validation ───────────────────────────────

const ALLOWED = {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'span', 'blockquote', 'code', 'mark', 'table', 'tr', 'td', 'th', 'tbody', 'thead', 'img', 'div'],
  allowedAttributes: { a: ['href', 'target', 'rel', 'style'], span: ['style'], p: ['style'], div: ['style'], td: ['style', 'align', 'width'], th: ['style', 'align'], table: ['style', 'width', 'cellpadding', 'cellspacing', 'border', 'role'], img: ['src', 'alt', 'width', 'height', 'style'], h1: ['style'], h2: ['style'], h3: ['style'], mark: ['style'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  allowedStyles: {
    '*': {
      color: [/^#[0-9a-fA-F]{3,8}$/, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/],
      'background-color': [/^#[0-9a-fA-F]{3,8}$/, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/],
      'text-align': [/^(left|right|center|justify)$/],
      'font-weight': [/^(\d{3}|bold|normal)$/],
      'font-size': [/^\d{1,2}px$/],
      padding: [/^[\d\spx]+$/], margin: [/^[\d\spx]+$/], width: [/^\d+(px|%)$/], 'max-width': [/^\d+(px|%)$/], 'text-decoration': [/^(none|underline|line-through)$/],
    },
  },
  // Variables like {{unsubscribeUrl}} must survive as hrefs.
  transformTags: {},
} satisfies sanitizeHtml.IOptions;

export function sanitizeEmailHtml(html: string) {
  // Allow {{var}} placeholders inside href by temporarily encoding them as https URLs.
  const encoded = html.replace(/href="\{\{\s*([a-zA-Z]+)\s*\}\}"/g, 'href="https://var.invalid/$1"');
  const clean = sanitizeHtml(encoded, ALLOWED);
  return clean.replace(/href="https:\/\/var\.invalid\/([a-zA-Z]+)"/g, 'href="{{$1}}"');
}

const align = z.enum(['left', 'center', 'right']);
const htmlField = z.string().max(50_000).transform(sanitizeEmailHtml);
const blockSchema: z.ZodType<Block> = z.discriminatedUnion('type', [
  z.object({ id: z.string().max(40), type: z.literal('heading'), text: z.string().max(300), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), align }),
  z.object({ id: z.string().max(40), type: z.literal('text'), html: htmlField, align }),
  z.object({ id: z.string().max(40), type: z.literal('button'), label: z.string().max(80), url: z.string().max(2000), align, variant: z.enum(['solid', 'outline']), fullWidth: z.boolean() }),
  z.object({ id: z.string().max(40), type: z.literal('image'), src: z.string().max(2000), alt: z.string().max(200), width: z.number().min(10).max(100), href: z.string().max(2000), align }),
  z.object({ id: z.string().max(40), type: z.literal('divider') }),
  z.object({ id: z.string().max(40), type: z.literal('spacer'), height: z.number().min(4).max(160) }),
  z.object({ id: z.string().max(40), type: z.literal('columns'), left: htmlField, right: htmlField }),
  z.object({ id: z.string().max(40), type: z.literal('quote'), html: htmlField, author: z.string().max(120) }),
  z.object({ id: z.string().max(40), type: z.literal('footer'), html: htmlField }),
  z.object({ id: z.string().max(40), type: z.literal('html'), html: htmlField }),
]) as unknown as z.ZodType<Block>;

const hex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/);
export const designSchema = z.object({
  version: z.literal(1),
  settings: z.object({
    width: z.number().int().min(480).max(800), background: hex, canvas: hex, text: hex, muted: hex, accent: hex, accentText: hex,
    font: z.enum(['Helvetica', 'Georgia', 'Inter', 'Arial', 'Trebuchet']), radius: z.number().int().min(0).max(24), padding: z.number().int().min(12).max(64),
  }),
  blocks: z.array(blockSchema).min(1).max(80),
});

// ── SMTP accounts ──────────────────────────────────────────────────

export const smtpInput = z.object({
  label: z.string().trim().min(2).max(80),
  host: z.string().trim().min(3).max(253).regex(/^[a-zA-Z0-9.-]+$/, 'Use a hostname or IP address'),
  port: z.number().int().refine((p) => [25, 465, 587, 2525, 1025].includes(p), 'Allowed ports: 25, 465, 587, 2525 (1025 for local testing)'),
  secure: z.boolean(),
  username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(500).optional(),
  fromName: z.string().trim().min(1).max(120),
  fromEmail: z.string().trim().toLowerCase().email().max(254),
  replyTo: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  dailyLimit: z.number().int().min(1).max(100_000),
  perMinuteLimit: z.number().int().min(1).max(600),
  isDefault: z.boolean(),
});

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const isPrivate = (ip: string) => PRIVATE_V4.some((r) => r.test(ip)) || ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith('::ffff:127.');

/**
 * SSRF guard: workspace-supplied SMTP hosts must resolve to public addresses. We connect to the
 * resolved IP (with the original name for TLS SNI) so DNS rebinding cannot swap the target afterwards.
 */
async function resolveHost(host: string, allowPrivate: boolean) {
  const ip = isIP(host) ? host : (await lookup(host).catch(() => { throw new AppError('VALIDATION_FAILED', `Cannot resolve SMTP host ${host}`); })).address;
  if (!allowPrivate && isPrivate(ip)) throw new AppError('VALIDATION_FAILED', 'SMTP host resolves to a private or loopback address, which is not allowed');
  return ip;
}

export async function transportFor(acc: SmtpAccount) {
  const allowPrivate = acc.organizationId === null || process.env.SMTP_ALLOW_PRIVATE_HOSTS === 'true';
  const ip = await resolveHost(acc.host, allowPrivate);
  const nodemailer = await import('nodemailer');
  return nodemailer.createTransport({
    host: ip, port: acc.port, secure: acc.secure, auth: { user: acc.username, pass: decrypt(acc.passwordEnc) }, ...transportExtras(acc),
    tls: { servername: isIP(acc.host) ? undefined : acc.host, minVersion: 'TLSv1.2' },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
}

const publicAccount = (a: SmtpAccount) => {
  const { passwordEnc: _p, dkimPrivateKeyEnc: _k, ...rest } = a;
  return { ...rest, hasPassword: Boolean(_p) };
};

export async function listSmtpAccounts(ctx: AuthContext) {
  const rows = await scopeDb(ctx, (tx) => tx.smtpAccount.findMany({ where: { organizationId: orgOf(ctx), deletedAt: null }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }));
  const since = new Date(Date.now() - 86400_000);
  const counts = await scopeDb(ctx, (tx) => tx.emailMessage.groupBy({ by: ['smtpAccountId'], where: { organizationId: orgOf(ctx), status: 'SENT', sentAt: { gte: since } }, _count: true }));
  const m = new Map(counts.map((c) => [c.smtpAccountId, c._count]));
  return rows.map((r) => ({ ...publicAccount(r), sentLast24h: m.get(r.id) ?? 0 }));
}

export async function saveSmtpAccount(ctx: AuthContext, id: string | null, input: z.infer<typeof smtpInput>) {
  const org = orgOf(ctx);
  await resolveHost(input.host, org === null || process.env.SMTP_ALLOW_PRIVATE_HOSTS === 'true');
  return scopeDb(ctx, async (tx) => {
    const { password, ...rest } = input;
    if (input.isDefault) await tx.smtpAccount.updateMany({ where: { organizationId: org, isDefault: true }, data: { isDefault: false } });
    let row: SmtpAccount;
    if (id) {
      const existing = await tx.smtpAccount.findFirst({ where: { id, organizationId: org, deletedAt: null } });
      if (!existing) throw notFound('SMTP account');
      const connectionChanged = ['host', 'port', 'secure', 'username'].some((k) => (existing as Record<string, unknown>)[k] !== (rest as Record<string, unknown>)[k]) || Boolean(password);
      row = await tx.smtpAccount.update({ where: { id }, data: { ...rest, ...(password ? { passwordEnc: encrypt(password) } : {}), ...(connectionChanged ? { status: 'UNVERIFIED', lastError: null } : {}) } });
    } else {
      if (!password) throw new AppError('VALIDATION_FAILED', 'Password is required');
      const count = await tx.smtpAccount.count({ where: { organizationId: org, deletedAt: null } });
      row = await tx.smtpAccount.create({ data: { ...rest, isDefault: input.isDefault || count === 0, passwordEnc: encrypt(password), organizationId: org, createdById: ctx.user.id } });
    }
    await audit(tx, ctx, { action: id ? 'email.smtp.updated' : 'email.smtp.created', targetType: 'smtp_account', targetId: row.id, after: { ...rest, passwordChanged: Boolean(password) } });
    return publicAccount(row);
  });
}

export async function deleteSmtpAccount(ctx: AuthContext, id: string) {
  return scopeDb(ctx, async (tx) => {
    const acc = await tx.smtpAccount.findFirst({ where: { id, organizationId: orgOf(ctx), deletedAt: null } });
    if (!acc) throw notFound('SMTP account');
    const active = await tx.emailCampaign.count({ where: { smtpAccountId: id, status: { in: ['QUEUED', 'SENDING', 'SCHEDULED'] } } });
    if (active) throw new AppError('CONFLICT', 'This sender has campaigns in progress');
    await tx.smtpAccount.update({ where: { id }, data: { deletedAt: new Date(), isDefault: false, passwordEnc: encrypt('deleted') } });
    await audit(tx, ctx, { action: 'email.smtp.deleted', targetType: 'smtp_account', targetId: id, before: { label: acc.label, host: acc.host } });
  });
}

async function loadAccount(ctx: AuthContext, id: string) {
  const acc = await scopeDb(ctx, (tx) => tx.smtpAccount.findFirst({ where: { id, organizationId: orgOf(ctx), deletedAt: null } }));
  if (!acc) throw notFound('SMTP account');
  return acc;
}

/** Opens an SMTP session and authenticates (no email sent). Records the outcome on the account. */
export async function verifySmtpAccount(ctx: AuthContext, id: string) {
  const lim = await rateLimit(`smtp-verify:${ctx.user.id}`, 20, 3600);
  if (!lim.ok) throw new AppError('RATE_LIMITED', 'Too many verification attempts');
  const acc = await loadAccount(ctx, id);
  let ok = true;
  let error: string | null = null;
  try {
    const t = await transportFor(acc);
    await t.verify();
    t.close();
  } catch (e) {
    ok = false;
    error = e instanceof AppError ? e.message : String((e as Error).message).slice(0, 300);
  }
  await scopeDb(ctx, (tx) => tx.smtpAccount.update({ where: { id }, data: { status: ok ? 'VERIFIED' : 'FAILED', lastVerifiedAt: new Date(), lastError: error } }));
  return { ok, error };
}

// ── Templates ──────────────────────────────────────────────────────

export const templateInput = z.object({
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().max(60).nullable().optional(),
  subject: z.string().trim().max(300),
  preheader: z.string().trim().max(300).nullable().optional(),
  design: designSchema,
});

export async function listEmailTemplates(ctx: AuthContext) {
  return scopeDb(ctx, (tx) => tx.emailTemplate.findMany({
    where: { organizationId: orgOf(ctx), archivedAt: null }, orderBy: { updatedAt: 'desc' },
    select: { id: true, name: true, category: true, subject: true, preheader: true, updatedAt: true, createdAt: true, design: true },
  }));
}

export async function getEmailTemplate(ctx: AuthContext, id: string) {
  const t = await scopeDb(ctx, (tx) => tx.emailTemplate.findFirst({ where: { id, organizationId: orgOf(ctx), archivedAt: null } }));
  if (!t) throw notFound('Template');
  return t;
}

export async function saveEmailTemplate(ctx: AuthContext, id: string | null, input: z.infer<typeof templateInput>) {
  const { html, text } = renderEmail(input.design as EmailDesign, { preheader: input.preheader, vars: {} });
  return scopeDb(ctx, async (tx) => {
    const data = { name: input.name, category: input.category ?? null, subject: input.subject, preheader: input.preheader ?? null, design: input.design as unknown as Prisma.InputJsonValue, html, text, updatedById: ctx.user.id };
    const row = id
      ? await (async () => {
          const ex = await tx.emailTemplate.findFirst({ where: { id, organizationId: orgOf(ctx), archivedAt: null } });
          if (!ex) throw notFound('Template');
          return tx.emailTemplate.update({ where: { id }, data });
        })()
      : await tx.emailTemplate.create({ data: { ...data, organizationId: orgOf(ctx), createdById: ctx.user.id } });
    await audit(tx, ctx, { action: id ? 'email.template.updated' : 'email.template.created', targetType: 'email_template', targetId: row.id, after: { name: input.name, subject: input.subject } });
    return { id: row.id, name: row.name, updatedAt: row.updatedAt };
  });
}

export async function archiveEmailTemplate(ctx: AuthContext, id: string) {
  return scopeDb(ctx, async (tx) => {
    const res = await tx.emailTemplate.updateMany({ where: { id, organizationId: orgOf(ctx), archivedAt: null }, data: { archivedAt: new Date() } });
    if (!res.count) throw notFound('Template');
    await audit(tx, ctx, { action: 'email.template.archived', targetType: 'email_template', targetId: id });
  });
}

// ── Recipients ─────────────────────────────────────────────────────

export const audienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('platform'), selection: selectionSchema }),
  z.object({ kind: z.literal('workspace'), ids: z.array(z.string().max(64)).max(5000).optional(), filter: filterSchema.optional(), view: z.enum(['active', 'unassigned', 'archived']).optional() }),
]);
type Audience = z.infer<typeof audienceSchema>;

type Recipient = { leadId: string | null; clientLeadId: string | null; email: string | null; vars: Variables };

const MAX_WORKSPACE_RECIPIENTS = 5000;
const MAX_PLATFORM_RECIPIENTS = 50_000;

export function splitName(full: string) {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}

async function resolveRecipients(ctx: AuthContext, audience: Audience): Promise<Recipient[]> {
  if (ctx.scope === 'PLATFORM') {
    if (audience.kind !== 'platform') throw new AppError('VALIDATION_FAILED', 'Invalid audience for platform sending');
    return withPlatform(async (tx) => {
      const ids = await resolveLeadSelection(tx, audience.selection, {}, 'active');
      if (ids.length > MAX_PLATFORM_RECIPIENTS) throw new AppError('VALIDATION_FAILED', `Campaigns are limited to ${MAX_PLATFORM_RECIPIENTS.toLocaleString()} recipients`);
      const out: Recipient[] = [];
      for (let i = 0; i < ids.length; i += 5000) {
        const rows = await tx.lead.findMany({ where: { id: { in: ids.slice(i, i + 5000) } }, select: { id: true, fullName: true, email: true, emailNormalized: true, company: true, jobTitle: true, city: true, country: true } });
        for (const r of rows) out.push({ leadId: r.id, clientLeadId: null, email: r.emailNormalized, vars: { ...splitName(r.fullName), fullName: r.fullName, company: r.company ?? '', jobTitle: r.jobTitle ?? '', city: r.city ?? '', country: r.country ?? '' } });
      }
      return out;
    }, { timeout: 120_000 });
  }
  if (audience.kind !== 'workspace') throw new AppError('VALIDATION_FAILED', 'Invalid audience for workspace sending');
  const org = ctx.orgId!;
  return withTenant(org, async (tx) => {
    const ownerOnly = can(ctx, 'crm.leads.read_all') ? null : ctx.user.id;
    const base = buildClientLeadWhere(org, audience.filter ?? { conditions: [] }, { ownerOnly, view: audience.view === 'archived' ? 'archived' : 'active' });
    const where: Prisma.ClientLeadWhereInput = {
      AND: [base, ...(audience.ids?.length ? [{ id: { in: audience.ids } }] : []), ...(audience.view === 'unassigned' ? [{ ownerId: null }] : [])],
    };
    const count = await tx.clientLead.count({ where });
    if (count > MAX_WORKSPACE_RECIPIENTS) throw new AppError('VALIDATION_FAILED', `Campaigns are limited to ${MAX_WORKSPACE_RECIPIENTS.toLocaleString()} recipients. Narrow the selection.`);
    const rows = await tx.clientLead.findMany({ where, select: { id: true, leadId: true, fullName: true, email: true, company: true, jobTitle: true, city: true, country: true } });
    return rows.map((r) => ({ leadId: r.leadId, clientLeadId: r.id, email: normalizeEmail(r.email).value, vars: { ...splitName(r.fullName), fullName: r.fullName, company: r.company ?? '', jobTitle: r.jobTitle ?? '', city: r.city ?? '', country: r.country ?? '' } }));
  }, { timeout: 60_000 });
}

async function classify(ctx: AuthContext, recipients: Recipient[]) {
  const org = orgOf(ctx);
  const hashes = [...new Set(recipients.map((r) => (r.email ? sha256(r.email) : null)).filter(Boolean) as string[])];
  const suppressed = new Set<string>();
  for (let i = 0; i < hashes.length; i += 5000) {
    const rows = await scopeDb(ctx, (tx) => tx.emailSuppression.findMany({ where: { organizationId: org, emailHash: { in: hashes.slice(i, i + 5000) } }, select: { emailHash: true } }));
    rows.forEach((r) => suppressed.add(r.emailHash));
  }
  const optedOut = new Set<string>();
  if (org) {
    const ids = recipients.map((r) => r.clientLeadId).filter(Boolean) as string[];
    const consents = await withTenant(org, (tx) => tx.consentRecord.findMany({ where: { clientLeadId: { in: ids }, channel: 'EMAIL' }, orderBy: { createdAt: 'desc' }, select: { clientLeadId: true, status: true } }));
    const latest = new Map<string, string>();
    for (const c of consents) if (!latest.has(c.clientLeadId)) latest.set(c.clientLeadId, c.status);
    for (const [id, st] of latest) if (st === 'OPTED_OUT') optedOut.add(id);
  }
  const seen = new Set<string>();
  return recipients.map((r) => {
    let skip: string | null = null;
    if (!r.email) skip = 'No valid email address';
    else if (suppressed.has(sha256(r.email))) skip = 'Unsubscribed or suppressed';
    else if (r.clientLeadId && optedOut.has(r.clientLeadId)) skip = 'Opted out of email';
    else if (seen.has(r.email)) skip = 'Duplicate address in this campaign';
    if (r.email) seen.add(r.email);
    return { ...r, skip };
  });
}

export async function previewAudience(ctx: AuthContext, audience: Audience) {
  const list = await classify(ctx, await resolveRecipients(ctx, audience));
  const reasons: Record<string, number> = {};
  for (const r of list) if (r.skip) reasons[r.skip] = (reasons[r.skip] ?? 0) + 1;
  const first = list.find((r) => !r.skip);
  return { total: list.length, sendable: list.filter((r) => !r.skip).length, skipped: reasons, sample: first ? { ...first.vars, email: maskEmail(first.email) } : null };
}

// ── Campaigns ──────────────────────────────────────────────────────

export const campaignInput = z.object({
  name: z.string().trim().min(2).max(160),
  smtpAccountId: z.string().max(64),
  templateId: z.string().max(64).nullable().optional(),
  subject: z.string().trim().min(1).max(300),
  preheader: z.string().trim().max(300).nullable().optional(),
  design: designSchema,
  audience: audienceSchema,
  trackOpens: z.boolean().default(true),
  scheduledFor: z.coerce.date().nullable().optional(),
  confirmLarge: z.boolean().default(false),
});

export function senderVars(acc: SmtpAccount, orgName: string): Variables {
  return { senderName: acc.fromName, senderEmail: acc.fromEmail, organizationName: orgName, currentYear: String(new Date().getFullYear()) };
}

export async function createCampaign(ctx: AuthContext, input: z.infer<typeof campaignInput>) {
  const acc = await loadAccount(ctx, input.smtpAccountId);
  if (acc.status === 'FAILED') throw new AppError('PRECONDITION_FAILED', 'This sender failed verification. Fix its settings and verify it first.');
  const list = await classify(ctx, await resolveRecipients(ctx, input.audience));
  const sendable = list.filter((r) => !r.skip).length;
  if (!sendable) throw new AppError('VALIDATION_FAILED', 'None of the selected leads can be emailed (no valid address, unsubscribed or opted out)');
  if (sendable >= 200 && !input.confirmLarge) throw new AppError('PRECONDITION_FAILED', `This campaign emails ${sendable} people. Large sends require confirmation.`, { sendable });
  const scheduled = input.scheduledFor && input.scheduledFor.getTime() > Date.now() + 30_000 ? input.scheduledFor : null;
  const campaign = await scopeDb(ctx, async (tx) => {
    const c = await tx.emailCampaign.create({
      data: {
        organizationId: orgOf(ctx), name: input.name, smtpAccountId: acc.id, templateId: input.templateId ?? null, subject: input.subject, preheader: input.preheader ?? null,
        design: input.design as unknown as Prisma.InputJsonValue, status: scheduled ? 'SCHEDULED' : 'QUEUED', audience: input.audience as unknown as Prisma.InputJsonValue,
        trackOpens: input.trackOpens, scheduledFor: scheduled, totalRecipients: list.length, skippedCount: list.length - sendable, createdById: ctx.user.id,
      },
    });
    const now = new Date();
    for (let i = 0; i < list.length; i += 2000) {
      await tx.emailMessage.createMany({
        data: list.slice(i, i + 2000).map((r) => ({
          organizationId: orgOf(ctx), campaignId: c.id, smtpAccountId: acc.id, leadId: r.leadId, clientLeadId: r.clientLeadId,
          toEmail: r.email ?? '', toName: r.vars.fullName ?? null, subject: input.subject, status: r.skip ? ('SKIPPED' as const) : ('QUEUED' as const),
          error: r.skip, trackingToken: randomToken(18), queuedAt: now,
        })),
      });
    }
    await audit(tx, ctx, { action: 'email.campaign.created', targetType: 'email_campaign', targetId: c.id, metadata: { name: input.name, recipients: list.length, sendable, scheduled, smtp: acc.label } });
    return c;
  }, 120_000);
  await enqueue('email', 'campaign', { campaignId: campaign.id }, { jobId: `campaign-${campaign.id}-${Date.now()}`, delay: scheduled ? scheduled.getTime() - Date.now() : 0 });
  return campaign;
}

export async function cancelCampaign(ctx: AuthContext, id: string) {
  return scopeDb(ctx, async (tx) => {
    const c = await tx.emailCampaign.findFirst({ where: { id, organizationId: orgOf(ctx) } });
    if (!c) throw notFound('Campaign');
    if (!['SCHEDULED', 'QUEUED', 'SENDING'].includes(c.status)) throw new AppError('CONFLICT', 'This campaign is no longer running');
    const res = await tx.emailMessage.updateMany({ where: { campaignId: id, status: 'QUEUED' }, data: { status: 'CANCELLED' } });
    await tx.emailCampaign.update({ where: { id }, data: { status: 'CANCELLED', completedAt: new Date() } });
    await audit(tx, ctx, { action: 'email.campaign.cancelled', targetType: 'email_campaign', targetId: id, metadata: { cancelledMessages: res.count } });
    return { cancelled: res.count };
  });
}

export async function retryFailed(ctx: AuthContext, id: string) {
  const res = await scopeDb(ctx, async (tx) => {
    const c = await tx.emailCampaign.findFirst({ where: { id, organizationId: orgOf(ctx) } });
    if (!c) throw notFound('Campaign');
    if (['QUEUED', 'SENDING', 'SCHEDULED'].includes(c.status)) throw new AppError('CONFLICT', 'Campaign is still running');
    const r = await tx.emailMessage.updateMany({ where: { campaignId: id, status: 'FAILED' }, data: { status: 'QUEUED', attempts: 0, error: null } });
    if (!r.count) throw new AppError('CONFLICT', 'There are no failed messages to retry');
    await tx.emailCampaign.update({ where: { id }, data: { status: 'QUEUED', failedCount: { decrement: r.count }, completedAt: null } });
    await audit(tx, ctx, { action: 'email.campaign.retried', targetType: 'email_campaign', targetId: id, metadata: { messages: r.count } });
    return r.count;
  });
  await enqueue('email', 'campaign', { campaignId: id }, { jobId: `campaign-${id}-${Date.now()}` });
  return { requeued: res };
}

export async function listCampaigns(ctx: AuthContext, params: { page: number; pageSize: number }) {
  return scopeDb(ctx, async (tx) => {
    const where = { organizationId: orgOf(ctx) };
    const [total, rows] = await Promise.all([
      tx.emailCampaign.count({ where }),
      tx.emailCampaign.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize, select: { id: true, name: true, subject: true, status: true, totalRecipients: true, sentCount: true, failedCount: true, skippedCount: true, openedCount: true, trackOpens: true, scheduledFor: true, createdAt: true, completedAt: true, createdById: true, smtpAccountId: true } }),
    ]);
    const users = await tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, name: true } });
    const accs = await tx.smtpAccount.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.smtpAccountId))] } }, select: { id: true, label: true, fromEmail: true } });
    const um = new Map(users.map((u) => [u.id, u.name]));
    const am = new Map(accs.map((a) => [a.id, a]));
    return { total, rows: rows.map((r) => ({ ...r, createdBy: um.get(r.createdById) ?? '—', sender: am.get(r.smtpAccountId) ?? null })) };
  });
}

export async function getCampaign(ctx: AuthContext, id: string) {
  return scopeDb(ctx, async (tx) => {
    const c = await tx.emailCampaign.findFirst({ where: { id, organizationId: orgOf(ctx) } });
    if (!c) throw notFound('Campaign');
    const [byStatus, sender, creator, timeline] = await Promise.all([
      tx.emailMessage.groupBy({ by: ['status'], where: { campaignId: id }, _count: true }),
      tx.smtpAccount.findUnique({ where: { id: c.smtpAccountId }, select: { label: true, fromEmail: true, fromName: true } }),
      tx.user.findUnique({ where: { id: c.createdById }, select: { name: true } }),
      tx.$queryRaw<{ hour: Date; sent: bigint; opened: bigint }[]>`
        SELECT date_trunc('hour', coalesce("sentAt", "queuedAt")) AS hour, count(*) FILTER (WHERE status = 'SENT') AS sent, count(*) FILTER (WHERE "openedAt" IS NOT NULL) AS opened
        FROM email_messages WHERE "campaignId" = ${id} AND "sentAt" IS NOT NULL GROUP BY 1 ORDER BY 1 LIMIT 200`,
    ]);
    const { html } = renderEmail(c.design as unknown as EmailDesign, { preheader: c.preheader, vars: { firstName: 'Jordan', lastName: 'Rivera', fullName: 'Jordan Rivera', company: 'Northwind', senderName: sender?.fromName ?? '', senderEmail: sender?.fromEmail ?? '', organizationName: '', unsubscribeUrl: '#', currentYear: String(new Date().getFullYear()) } });
    return {
      campaign: c, sender, creator, html,
      byStatus: Object.fromEntries(byStatus.map((b) => [b.status, b._count])),
      timeline: timeline.map((t) => ({ hour: t.hour.toISOString(), sent: Number(t.sent), opened: Number(t.opened) })),
    };
  });
}

export async function listMessages(ctx: AuthContext, params: { campaignId?: string; status?: string; q?: string; page: number; pageSize: number }) {
  return scopeDb(ctx, async (tx) => {
    const where: Prisma.EmailMessageWhereInput = {
      organizationId: orgOf(ctx),
      ...(params.campaignId ? { campaignId: params.campaignId } : {}),
      ...(params.status ? { status: params.status as EmailMessage['status'] } : {}),
      ...(params.q ? { OR: [{ toName: { contains: params.q, mode: 'insensitive' } }, { subject: { contains: params.q, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      tx.emailMessage.count({ where }),
      tx.emailMessage.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize, include: { campaign: { select: { id: true, name: true } } } }),
    ]);
    // Recipient addresses are masked in logs; workspace users never see raw lead emails here.
    return { total, rows: rows.map(({ trackingToken: _t, toEmail, ...r }) => ({ ...r, toEmail: maskEmail(toEmail) })) };
  });
}

export async function emailStats(ctx: AuthContext) {
  return scopeDb(ctx, async (tx) => {
    const since = new Date(Date.now() - 30 * 86400_000);
    const rows = await tx.emailMessage.groupBy({ by: ['status'], where: { organizationId: orgOf(ctx), createdAt: { gte: since } }, _count: true });
    const opened = await tx.emailMessage.count({ where: { organizationId: orgOf(ctx), createdAt: { gte: since }, openedAt: { not: null } } });
    const by = Object.fromEntries(rows.map((r) => [r.status, r._count])) as Record<string, number>;
    const sent = by.SENT ?? 0;
    return { sent, failed: by.FAILED ?? 0, skipped: by.SKIPPED ?? 0, queued: (by.QUEUED ?? 0) + (by.SENDING ?? 0), opened, openRate: sent ? opened / sent : null };
  });
}

// ── Sending (worker) ───────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function recordContact(m: EmailMessage, subject: string, providerMessageId: string | null, actorId: string) {
  if (m.organizationId && m.clientLeadId) {
    await withTenant(m.organizationId, async (tx) => {
      const cl = await tx.clientLead.findFirst({ where: { id: m.clientLeadId!, revokedAt: null } });
      if (!cl) return;
      await tx.communicationLog.create({ data: { organizationId: m.organizationId!, clientLeadId: cl.id, userId: actorId, channel: 'EMAIL', direction: 'OUTBOUND', outcome: 'SENT', subject, verification: 'PROVIDER_VERIFIED', provider: 'smtp', providerMessageId } });
      await tx.clientLead.update({ where: { id: cl.id }, data: { lastActivityAt: new Date(), ...(cl.firstContactAt ? {} : { firstContactAt: new Date() }) } });
      await tx.activity.create({ data: { organizationId: m.organizationId!, clientLeadId: cl.id, leadId: cl.leadId, actorId, type: ACTIVITY.CONTACT_LOGGED, verification: 'PROVIDER_VERIFIED', summary: `Email sent: ${subject.slice(0, 120)}`, data: { messageId: m.id } } });
    });
  } else if (m.leadId) {
    await withPlatform((tx) => tx.activity.create({ data: { leadId: m.leadId, actorId, type: ACTIVITY.CONTACT_LOGGED, verification: 'PROVIDER_VERIFIED', summary: `Platform email sent: ${subject.slice(0, 120)}`, data: { messageId: m.id } } }));
  }
}

/** Worker: sends a campaign's queued messages, honouring the sender's per-minute and daily limits. Safe to re-run. */
export async function runCampaign(campaignId: string) {
  const c = await withPlatform((tx) => tx.emailCampaign.findUnique({ where: { id: campaignId } }));
  if (!c || !['QUEUED', 'SENDING', 'SCHEDULED'].includes(c.status)) return null;
  const acc = await withPlatform((tx) => tx.smtpAccount.findUnique({ where: { id: c.smtpAccountId } }));
  if (!acc || acc.deletedAt) {
    await withPlatform((tx) => tx.emailCampaign.update({ where: { id: campaignId }, data: { status: 'FAILED', error: 'Sender account no longer exists', completedAt: new Date() } }));
    return null;
  }
  await withPlatform((tx) => tx.emailCampaign.update({ where: { id: campaignId }, data: { status: 'SENDING', startedAt: c.startedAt ?? new Date() } }));
  const orgName = c.organizationId ? ((await prisma.organization.findUnique({ where: { id: c.organizationId }, select: { name: true } }))?.name ?? '') : (process.env.PLATFORM_NAME ?? (await productName()));
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const design = c.design as unknown as EmailDesign;
  // Welcome campaigns create each recipient's account (and temporary password) just before their email.
  const welcome = (await import('./welcome').then((w) => (w.isWelcomeAudience(c.audience) ? { audience: c.audience, provision: w.provisionWelcomeAccount } : null)));
  const gap = Math.ceil(60_000 / Math.max(1, acc.perMinuteLimit));
  let transport: Awaited<ReturnType<typeof transportFor>> | null = null;
  try {
    transport = await transportFor(acc);
  } catch (e) {
    await withPlatform((tx) => tx.emailCampaign.update({ where: { id: campaignId }, data: { status: 'FAILED', error: (e as Error).message.slice(0, 300), completedAt: new Date() } }));
    return null;
  }

  for (;;) {
    const current = await withPlatform((tx) => tx.emailCampaign.findUnique({ where: { id: campaignId }, select: { status: true } }));
    if (current?.status === 'CANCELLED') break;
    const sentToday = await withPlatform((tx) => tx.emailMessage.count({ where: { smtpAccountId: acc.id, status: 'SENT', sentAt: { gte: new Date(Date.now() - 86400_000) } } }));
    if (sentToday >= acc.dailyLimit) {
      // Daily cap reached: pause and resume later without failing anything.
      await withPlatform((tx) => tx.emailCampaign.update({ where: { id: campaignId }, data: { status: 'QUEUED', error: `Daily limit of ${acc.dailyLimit} reached for ${acc.label}; resuming automatically` } }));
      await enqueue('email', 'campaign', { campaignId }, { jobId: `campaign-${campaignId}-${Date.now()}`, delay: 30 * 60_000 });
      transport.close();
      return null;
    }
    const batch = await withPlatform((tx) => tx.emailMessage.findMany({ where: { campaignId, status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, take: Math.min(50, acc.dailyLimit - sentToday) }));
    if (!batch.length) break;
    for (const m of batch) {
      const suppressed = await withPlatform((tx) => tx.emailSuppression.findFirst({ where: { organizationId: c.organizationId, emailHash: sha256(m.toEmail) } }));
      if (suppressed) {
        await withPlatform(async (tx) => {
          await tx.emailMessage.update({ where: { id: m.id }, data: { status: 'SKIPPED', error: 'Unsubscribed before sending' } });
          await tx.emailCampaign.update({ where: { id: campaignId }, data: { skippedCount: { increment: 1 } } });
          await recordMessageEvent(m.id, { type: 'SKIPPED', detail: 'Unsubscribed before sending' }, tx);
        });
        continue;
      }
      const full = (m.toName ?? '').trim();
      const vars: Variables = {
        ...senderVars(acc, orgName), ...splitName(full), fullName: full,
        unsubscribeUrl: `${appUrl}/unsubscribe/${m.trackingToken}`,
      };
      if (m.clientLeadId && m.organizationId) {
        const cl = await withTenant(m.organizationId, (tx) => tx.clientLead.findUnique({ where: { id: m.clientLeadId! }, select: { company: true, jobTitle: true, city: true, country: true } }));
        Object.assign(vars, { company: cl?.company ?? '', jobTitle: cl?.jobTitle ?? '', city: cl?.city ?? '', country: cl?.country ?? '' });
      } else if (m.leadId) {
        const l = await withPlatform((tx) => tx.lead.findUnique({ where: { id: m.leadId! }, select: { company: true, jobTitle: true, city: true, country: true } }));
        Object.assign(vars, { company: l?.company ?? '', jobTitle: l?.jobTitle ?? '', city: l?.city ?? '', country: l?.country ?? '' });
      }
      await withPlatform((tx) => tx.emailMessage.update({ where: { id: m.id }, data: { status: 'SENDING', attempts: { increment: 1 } } }));
      if (welcome) {
        let account: Awaited<ReturnType<typeof welcome.provision>>;
        try {
          account = await welcome.provision(m, welcome.audience, c.createdById, m.attempts);
        } catch (err) {
          logger.error({ err, messageId: m.id }, 'welcome account provisioning failed');
          account = { skip: `Could not create the account: ${String((err as Error).message).slice(0, 200)}` };
        }
        if ('skip' in account) {
          await withPlatform(async (tx) => {
            await tx.emailMessage.update({ where: { id: m.id }, data: { status: 'SKIPPED', error: account.skip } });
            await tx.emailCampaign.update({ where: { id: campaignId }, data: { skippedCount: { increment: 1 } } });
            await recordMessageEvent(m.id, { type: 'SKIPPED', detail: account.skip }, tx);
          });
          continue;
        }
        Object.assign(vars, account.vars);
      }
      const { html, text } = renderEmail(design, { preheader: c.preheader, vars, trackingPixelUrl: c.trackOpens && trackingAllowed() ? `${appUrl}/api/v1/email/o/${m.trackingToken}` : null });
      // The subject is stored on the message, so a temporary password must never be rendered into it.
      const subject = renderSubject(c.subject, { ...vars, temporaryPassword: '' });
      try {
        const info = await transport.sendMail({
          from: { name: acc.fromName, address: acc.fromEmail }, replyTo: acc.replyTo ?? undefined, to: m.toName ? { name: m.toName, address: m.toEmail } : m.toEmail,
          subject, html, text,
          // Welcome emails are account mail (transactional); every other campaign is bulk mail and gets one-click unsubscribe.
          headers: { ...bulkHeaders({ trackingToken: m.trackingToken, feedbackId: campaignId, marketing: !welcome }), 'X-Campaign-Id': campaignId },
        });
        await withPlatform(async (tx) => {
          await tx.emailMessage.update({ where: { id: m.id }, data: { status: 'SENT', sentAt: new Date(), subject, providerMessageId: info.messageId ?? null, error: null } });
          await tx.emailCampaign.update({ where: { id: campaignId }, data: { sentCount: { increment: 1 } } });
          await recordMessageEvent(m.id, { type: 'SENT', detail: `Accepted by ${acc.label}${info.messageId ? ` · ${info.messageId}` : ''}` }, tx);
        });
        await recordContact(m, subject, info.messageId ?? null, c.createdById).catch((err) => logger.warn({ err }, 'failed to record email contact'));
      } catch (err) {
        const message = String((err as Error).message ?? err).slice(0, 300);
        const permanent = /^5\d\d/.test(String((err as { responseCode?: number }).responseCode ?? '')) || m.attempts + 1 >= 3;
        await withPlatform(async (tx) => {
          await tx.emailMessage.update({ where: { id: m.id }, data: { status: permanent ? 'FAILED' : 'QUEUED', error: message } });
          if (permanent) await tx.emailCampaign.update({ where: { id: campaignId }, data: { failedCount: { increment: 1 } } });
          await recordMessageEvent(m.id, { type: permanent ? 'FAILED' : 'RETRY', detail: message }, tx);
        });
      }
      await sleep(process.env.NODE_ENV === 'test' ? 0 : gap);
    }
  }
  transport.close();
  const final = await withPlatform(async (tx) => {
    const cur = await tx.emailCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (cur.status === 'CANCELLED') return cur;
    const status = cur.sentCount === 0 && cur.failedCount > 0 ? 'FAILED' : cur.failedCount > 0 ? 'PARTIAL' : 'COMPLETED';
    const done = await tx.emailCampaign.update({ where: { id: campaignId }, data: { status, completedAt: new Date(), error: null } });
    await notifyUsers([cur.createdById], { type: 'EMAIL_CAMPAIGN', title: `Campaign “${cur.name}” ${status.toLowerCase()}`, body: `${cur.sentCount} sent · ${cur.failedCount} failed · ${cur.skippedCount} skipped`, link: `${cur.organizationId ? '/app' : '/admin'}/email/campaigns/${cur.id}`, organizationId: cur.organizationId }, tx);
    return done;
  });
  return final;
}

export function renderSubject(subject: string, vars: Variables) {
  return subject.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_m, k: string) => (vars as Record<string, string | undefined>)[k] ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

/** Sends one rendered test email to an address the caller chooses (rate limited). */
export async function sendTest(ctx: AuthContext, input: { smtpAccountId: string; to: string; subject: string; preheader?: string | null; design: EmailDesign }) {
  const lim = await rateLimit(`email-test:${ctx.user.id}`, 20, 3600);
  if (!lim.ok) throw new AppError('RATE_LIMITED', 'Test email limit reached for this hour');
  const acc = await loadAccount(ctx, input.smtpAccountId);
  const orgName = ctx.org?.name ?? (process.env.PLATFORM_NAME ?? (await productName()));
  const vars: Variables = { ...senderVars(acc, orgName), firstName: 'Jordan', lastName: 'Rivera', fullName: 'Jordan Rivera', company: 'Northwind Traders', jobTitle: 'Operations Director', city: 'Austin', country: 'United States', unsubscribeUrl: `${process.env.APP_URL}/unsubscribe/test`,
    username: input.to, temporaryPassword: 'Sample-Only#2026', loginUrl: `${process.env.APP_URL}/login`, passwordExpiresOn: 'in 7 days', workspaceName: 'Northwind Traders' };
  const { html, text } = renderEmail(input.design, { preheader: input.preheader, vars });
  const t = await transportFor(acc);
  try {
    const info = await t.sendMail({ from: { name: acc.fromName, address: acc.fromEmail }, to: input.to, subject: `[Test] ${renderSubject(input.subject, vars)}`, html, text });
    await scopeDb(ctx, (tx) => audit(tx, ctx, { action: 'email.test.sent', targetType: 'smtp_account', targetId: acc.id, metadata: { to: maskEmail(input.to) } }));
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    throw new AppError('BAD_REQUEST', `SMTP error: ${String((e as Error).message).slice(0, 200)}`);
  } finally {
    t.close();
  }
}

// ── Public endpoints: opens & unsubscribe ──────────────────────────

export async function trackOpen(token: string, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) return;
  await withPlatform(async (tx) => {
    const m = await tx.emailMessage.findUnique({ where: { trackingToken: token }, select: { id: true, openedAt: true, openCount: true, campaignId: true, status: true } });
    if (!m || m.status !== 'SENT') return;
    await tx.emailMessage.update({ where: { id: m.id }, data: { openCount: { increment: 1 }, ...(m.openedAt ? {} : { openedAt: new Date() }) } });
    // Keep the timeline readable: the first 20 opens are listed individually, the count keeps going.
    if (m.openCount < 20) await recordMessageEvent(m.id, { type: 'OPENED', ip: meta.ip, userAgent: meta.userAgent }, tx);
    if (!m.openedAt && m.campaignId) await tx.emailCampaign.update({ where: { id: m.campaignId }, data: { openedCount: { increment: 1 } } });
  });
}

export async function unsubscribeInfo(token: string) {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) return null;
  const m = await withPlatform((tx) => tx.emailMessage.findUnique({ where: { trackingToken: token }, select: { toEmail: true, organizationId: true } }));
  if (!m) return null;
  const org = m.organizationId ? await prisma.organization.findUnique({ where: { id: m.organizationId }, select: { name: true } }) : null;
  return { email: maskEmail(m.toEmail), sender: org?.name ?? (process.env.PLATFORM_NAME ?? (await productName())) };
}

/** Records an unsubscribe: suppression for the sender's scope plus an EMAIL opt-out consent record for workspace leads. */
export async function unsubscribe(token: string) {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) throw notFound('Link');
  return withPlatform(async (tx) => {
    const m = await tx.emailMessage.findUnique({ where: { trackingToken: token } });
    if (!m) throw notFound('Link');
    const hash = sha256(m.toEmail);
    const exists = await tx.emailSuppression.findFirst({ where: { organizationId: m.organizationId, emailHash: hash } });
    if (!exists) await tx.emailSuppression.create({ data: { organizationId: m.organizationId, emailHash: hash, reason: 'UNSUBSCRIBED' } });
    if (m.organizationId && m.clientLeadId) {
      const cl = await tx.clientLead.findUnique({ where: { id: m.clientLeadId }, select: { id: true, leadId: true, ownerId: true } });
      if (cl) {
        await tx.consentRecord.create({ data: { organizationId: m.organizationId, clientLeadId: cl.id, channel: 'EMAIL', status: 'OPTED_OUT', source: 'Unsubscribe link', recordedById: 'system:unsubscribe-link' } });
        await tx.activity.create({ data: { organizationId: m.organizationId, clientLeadId: cl.id, leadId: cl.leadId, type: ACTIVITY.CONSENT_CHANGED, verification: 'SYSTEM_VERIFIED', summary: 'Unsubscribed from email via link' } });
      }
    }
    await tx.auditEvent.create({ data: { action: 'email.unsubscribed', organizationId: m.organizationId, targetType: 'email_message', targetId: m.id, result: 'SUCCESS' } });
    await recordMessageEvent(m.id, { type: 'UNSUBSCRIBED' }, tx);
    return { ok: true };
  });
}

/** Single-recipient send from a lead profile: a one-person campaign so it appears in the same log. */
export function directAudience(ctx: AuthContext, id: string): Audience {
  return ctx.scope === 'PLATFORM' ? { kind: 'platform', selection: { mode: 'ids', ids: [id] } } : { kind: 'workspace', ids: [id] };
}

export type { Selection };

// ── Automation sends ───────────────────────────────────────────────

/**
 * Queues one templated email to a workspace lead on behalf of a workflow. Sends from the workspace's
 * own default sender and honours unsubscribes and email opt-outs. Messages are grouped into one daily
 * campaign per workflow + template so they appear in the workspace's campaign list and delivery log.
 * Returns the campaign to start once the caller's transaction has committed.
 */
export async function queueAutomationEmail(tx: Tx, input: { organizationId: string; clientLeadId: string; templateId: string; workflowId: string; workflowName: string; actorId: string }): Promise<{ result: string; campaignId?: string }> {
  const org = await tx.organization.findUnique({ where: { id: input.organizationId }, select: { settings: true } });
  const features = ((org?.settings as { features?: { email?: boolean } } | null)?.features ?? {}) as { email?: boolean };
  if (features.email === false) return { result: 'skipped (email is turned off for this workspace)' };
  const tpl = await tx.emailTemplate.findFirst({ where: { id: input.templateId, archivedAt: null, OR: [{ organizationId: null }, { organizationId: input.organizationId }] } });
  if (!tpl) return { result: 'skipped (email template no longer exists)' };
  const sender =
    (await tx.smtpAccount.findFirst({ where: { organizationId: input.organizationId, deletedAt: null, isDefault: true, status: { not: 'FAILED' } } })) ??
    (await tx.smtpAccount.findFirst({ where: { organizationId: input.organizationId, deletedAt: null, status: 'VERIFIED' }, orderBy: { createdAt: 'asc' } }));
  if (!sender) return { result: 'skipped (workspace has no email sender)' };
  const lead = await tx.clientLead.findUnique({ where: { id: input.clientLeadId }, select: { leadId: true, fullName: true, email: true } });
  const email = normalizeEmail(lead?.email).value;
  if (!lead || !email) return { result: 'skipped (lead has no valid email)' };
  if (await tx.emailSuppression.findFirst({ where: { organizationId: input.organizationId, emailHash: sha256(email) } })) return { result: 'skipped (unsubscribed)' };
  const consent = await tx.consentRecord.findFirst({ where: { clientLeadId: input.clientLeadId, channel: 'EMAIL' }, orderBy: { createdAt: 'desc' }, select: { status: true } });
  if (consent?.status === 'OPTED_OUT') return { result: 'skipped (opted out of email)' };

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  let campaign = await tx.emailCampaign.findFirst({
    where: { organizationId: input.organizationId, templateId: tpl.id, createdAt: { gte: dayStart }, status: { notIn: ['CANCELLED', 'SCHEDULED'] }, audience: { path: ['workflowId'], equals: input.workflowId } },
    orderBy: { createdAt: 'desc' },
  });
  if (campaign) {
    campaign = await tx.emailCampaign.update({ where: { id: campaign.id }, data: { totalRecipients: { increment: 1 }, status: campaign.status === 'SENDING' ? 'SENDING' : 'QUEUED', completedAt: null } });
  } else {
    campaign = await tx.emailCampaign.create({
      data: {
        organizationId: input.organizationId, name: `Automation · ${input.workflowName}`, smtpAccountId: sender.id, templateId: tpl.id, subject: tpl.subject, preheader: tpl.preheader,
        design: tpl.design as Prisma.InputJsonValue, status: 'QUEUED', audience: { kind: 'automation', workflowId: input.workflowId } as Prisma.InputJsonValue,
        totalRecipients: 1, createdById: input.actorId,
      },
    });
  }
  await tx.emailMessage.create({
    data: {
      organizationId: input.organizationId, campaignId: campaign.id, smtpAccountId: campaign.smtpAccountId, leadId: lead.leadId, clientLeadId: input.clientLeadId,
      toEmail: email, toName: lead.fullName, subject: tpl.subject, status: 'QUEUED', trackingToken: randomToken(18),
    },
  });
  return { result: `queued email “${tpl.name}”`, campaignId: campaign.id };
}

export async function startCampaign(campaignId: string) {
  await enqueue('email', 'campaign', { campaignId }, { jobId: `campaign-${campaignId}-${Date.now()}` });
}
