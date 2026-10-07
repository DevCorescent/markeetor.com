import { Prisma, type EmailEndpoint, type EmailMessage, type SmtpAccount } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  defaultEndpointConfig, endpointConfigSchema, endpointInputSchema, ENDPOINT_EVENTS, evaluateConditions, getPath, nextInWindow, payloadVariables,
  type EndpointConfig, type EndpointInput,
} from '@/lib/email/endpoints';
import { renderEmail } from '@/lib/email/render';
import type { EmailDesign, Variables } from '@/lib/email/types';
import { maskEmail } from '@/lib/mask';
import { audit } from '../audit';
import { assertCan, can, type AuthContext } from '../auth/context';
import { productName } from '../branding';
import { decrypt, encrypt, randomToken, safeEqual, sha256 } from '../crypto';
import { withPlatform } from '../db';
import { AppError, notFound } from '../errors';
import { enqueue } from '../jobs/queues';
import { logger } from '../logger';
import { rateLimit } from '../ratelimit';
import { ACTIVITY } from './activity';
import { renderSubject, senderVars, splitName, transportFor } from './email';
import { bulkHeaders, trackingAllowed } from './deliverability';
import { recordMessageEvent } from './email-events';
import { normalizeEmail, toCsv } from './normalize';

/**
 * Email endpoints: named triggers that send the emails attached to them.
 *
 *  trigger (platform event | inbound webhook | test | replay)
 *    → ingest: paused? throttled? duplicate? conditions? recipients → one EmailEndpointEvent
 *    → one EmailMessage per recipient × attached email, scheduled by delay and send window
 *    → sendEndpointMessage (worker): claim, re-check window/suppression/frequency cap/sender limits,
 *      render, send, retry with backoff; every step lands on the message's timeline.
 *
 * A once-a-minute sweep re-queues anything whose job was lost, so a Redis hiccup never drops mail.
 */

const APP_URL = () => process.env.APP_URL ?? 'http://localhost:3000';
const LINK_SECRET = () => process.env.SESSION_SECRET ?? process.env.APP_SECRET ?? 'markeetor-links';
const MAX_PAYLOAD_BYTES = 256_000;

type Source = 'EVENT' | 'WEBHOOK' | 'TEST' | 'REPLAY';
export type IngestResult = { eventId: string; status: string; reason?: string | null; recipients: number; messages: number; duplicateOf?: string };

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'endpoint';

function configOf(ep: Pick<EmailEndpoint, 'config'>): EndpointConfig | null {
  const parsed = endpointConfigSchema.safeParse(ep.config);
  return parsed.success ? parsed.data : null;
}

async function resolveSender(ep: Pick<EmailEndpoint, 'smtpAccountId'>): Promise<SmtpAccount | null> {
  return withPlatform(async (tx) => {
    if (ep.smtpAccountId) return tx.smtpAccount.findFirst({ where: { id: ep.smtpAccountId, organizationId: null, deletedAt: null, status: { not: 'FAILED' } } });
    return (
      (await tx.smtpAccount.findFirst({ where: { organizationId: null, deletedAt: null, isDefault: true, status: { not: 'FAILED' } } })) ??
      (await tx.smtpAccount.findFirst({ where: { organizationId: null, deletedAt: null, status: 'VERIFIED' }, orderBy: { createdAt: 'asc' } }))
    );
  });
}

// ── Endpoint management ────────────────────────────────────────────

const webhookUrl = (slug: string) => `${APP_URL()}/api/v1/public/email/${slug}`;

function publicEndpoint(ep: EmailEndpoint) {
  const { tokenHash, signingSecretEnc, ...rest } = ep;
  return { ...rest, hasToken: Boolean(tokenHash), hasSigningSecret: Boolean(signingSecretEnc), webhookUrl: ep.triggerType === 'WEBHOOK' ? webhookUrl(ep.slug) : null };
}

async function stats(endpointIds: string[], days = 30) {
  if (!endpointIds.length) return new Map<string, EndpointStats>();
  const since = new Date(Date.now() - days * 86400_000);
  const [byStatus, opened, clicked, triggers, lastDay] = await withPlatform((tx) => Promise.all([
    tx.emailMessage.groupBy({ by: ['endpointId', 'status'], where: { endpointId: { in: endpointIds }, createdAt: { gte: since } }, _count: { _all: true } }),
    tx.emailMessage.groupBy({ by: ['endpointId'], where: { endpointId: { in: endpointIds }, createdAt: { gte: since }, openedAt: { not: null } }, _count: { _all: true } }),
    tx.emailMessage.groupBy({ by: ['endpointId'], where: { endpointId: { in: endpointIds }, createdAt: { gte: since }, clickedAt: { not: null } }, _count: { _all: true } }),
    tx.emailEndpointEvent.groupBy({ by: ['endpointId', 'status'], where: { endpointId: { in: endpointIds }, createdAt: { gte: since } }, _count: { _all: true } }),
    tx.emailEndpointEvent.groupBy({ by: ['endpointId'], where: { endpointId: { in: endpointIds }, createdAt: { gte: new Date(Date.now() - 86400_000) } }, _count: { _all: true } }),
  ]));
  const out = new Map<string, EndpointStats>();
  const get = (id: string) => {
    if (!out.has(id)) out.set(id, { triggers: 0, triggers24h: 0, accepted: 0, filtered: 0, queued: 0, sent: 0, failed: 0, skipped: 0, opened: 0, clicked: 0 });
    return out.get(id)!;
  };
  for (const r of byStatus) {
    const s = get(r.endpointId!);
    if (r.status === 'SENT') s.sent += r._count._all;
    else if (r.status === 'FAILED') s.failed += r._count._all;
    else if (r.status === 'SKIPPED' || r.status === 'CANCELLED') s.skipped += r._count._all;
    else s.queued += r._count._all;
  }
  for (const r of opened) get(r.endpointId!).opened = r._count._all;
  for (const r of clicked) get(r.endpointId!).clicked = r._count._all;
  for (const r of triggers) {
    const s = get(r.endpointId);
    s.triggers += r._count._all;
    if (r.status === 'ACCEPTED') s.accepted += r._count._all;
    if (r.status === 'FILTERED') s.filtered += r._count._all;
  }
  for (const r of lastDay) get(r.endpointId).triggers24h = r._count._all;
  return out;
}
export type EndpointStats = { triggers: number; triggers24h: number; accepted: number; filtered: number; queued: number; sent: number; failed: number; skipped: number; opened: number; clicked: number };

export async function listEndpoints(ctx: AuthContext) {
  assertCan(ctx, 'email.manage');
  const rows = await withPlatform((tx) => tx.emailEndpoint.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } }));
  const s = await stats(rows.map((r) => r.id));
  const templateIds = [...new Set(rows.flatMap((r) => configOf(r)?.steps.map((x) => x.templateId) ?? []))];
  const templates = await withPlatform((tx) => tx.emailTemplate.findMany({ where: { id: { in: templateIds } }, select: { id: true, name: true } }));
  const names = new Map(templates.map((t) => [t.id, t.name]));
  return {
    endpoints: rows.map((r) => ({
      ...publicEndpoint(r), config: undefined,
      emails: (configOf(r)?.steps ?? []).map((x) => ({ templateId: x.templateId, name: names.get(x.templateId) ?? 'Deleted template', delayMinutes: x.delayMinutes, enabled: x.enabled })),
      stats: s.get(r.id) ?? null,
    })),
  };
}

export async function getEndpoint(ctx: AuthContext, id: string) {
  assertCan(ctx, 'email.manage');
  const ep = await withPlatform((tx) => tx.emailEndpoint.findFirst({ where: { id, deletedAt: null } }));
  if (!ep) throw notFound('Endpoint');
  const s = await stats([ep.id]);
  return { ...publicEndpoint(ep), config: configOf(ep) ?? defaultEndpointConfig(), stats: s.get(ep.id) ?? null };
}

async function assertReferences(input: EndpointInput) {
  const ids = input.config.steps.map((s) => s.templateId);
  const found = await withPlatform((tx) => tx.emailTemplate.findMany({ where: { id: { in: ids }, organizationId: null, archivedAt: null }, select: { id: true } }));
  if (found.length !== new Set(ids).size) throw new AppError('VALIDATION_FAILED', 'One of the attached emails no longer exists. Pick another template.');
  if (input.smtpAccountId) {
    const acc = await withPlatform((tx) => tx.smtpAccount.findFirst({ where: { id: input.smtpAccountId!, organizationId: null, deletedAt: null } }));
    if (!acc) throw new AppError('VALIDATION_FAILED', 'That sender no longer exists');
  }
  if (input.config.delivery.sendWindow.enabled) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: input.config.delivery.sendWindow.timezone });
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Unknown time zone for the send window');
    }
  }
}

const activeCache = new Map<string, { at: number; active: boolean }>();
const invalidateActive = () => activeCache.clear();

/** Creates or updates an endpoint. New webhooks get a token, returned only in this response. */
export async function saveEndpoint(ctx: AuthContext, id: string | null, raw: EndpointInput) {
  assertCan(ctx, 'email.manage');
  const input = endpointInputSchema.parse(raw);
  await assertReferences(input);
  const secrets: { token?: string; signingSecret?: string } = {};
  const ep = await withPlatform(async (tx) => {
    const before = id ? await tx.emailEndpoint.findFirst({ where: { id, deletedAt: null } }) : null;
    if (id && !before) throw notFound('Endpoint');
    const data = {
      name: input.name, description: input.description, status: input.status, triggerType: input.triggerType,
      event: input.triggerType === 'EVENT' ? input.event : null, category: input.category, smtpAccountId: input.smtpAccountId,
      config: input.config as unknown as Prisma.InputJsonValue, updatedById: ctx.user.id,
    };
    let tokenData = {};
    if (input.triggerType === 'WEBHOOK' && !before?.tokenHash) {
      secrets.token = `mke_${randomToken(24)}`;
      tokenData = { tokenHash: sha256(secrets.token), tokenPreview: `${secrets.token.slice(0, 8)}…${secrets.token.slice(-4)}` };
    }
    if (input.triggerType === 'WEBHOOK' && input.config.webhook.requireSignature && !before?.signingSecretEnc) {
      secrets.signingSecret = `whsec_${randomToken(24)}`;
      tokenData = { ...tokenData, signingSecretEnc: encrypt(secrets.signingSecret) };
    }
    let saved: EmailEndpoint;
    if (before) {
      saved = await tx.emailEndpoint.update({ where: { id: before.id }, data: { ...data, ...tokenData } });
    } else {
      const base = slugify(input.name);
      let slug = base;
      for (let i = 2; await tx.emailEndpoint.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
      saved = await tx.emailEndpoint.create({ data: { ...data, ...tokenData, slug, createdById: ctx.user.id } });
    }
    await audit(tx, ctx, {
      action: before ? 'email.endpoint.updated' : 'email.endpoint.created', targetType: 'email_endpoint', targetId: saved.id, organizationId: null,
      before: before ? { name: before.name, status: before.status, triggerType: before.triggerType, event: before.event } : undefined,
      after: { name: saved.name, status: saved.status, triggerType: saved.triggerType, event: saved.event, emails: input.config.steps.length },
    });
    return saved;
  });
  invalidateActive();
  return { endpoint: { ...publicEndpoint(ep), config: input.config }, ...secrets };
}

export async function rotateEndpointSecret(ctx: AuthContext, id: string, kind: 'token' | 'signing') {
  assertCan(ctx, 'email.manage');
  return withPlatform(async (tx) => {
    const ep = await tx.emailEndpoint.findFirst({ where: { id, deletedAt: null } });
    if (!ep) throw notFound('Endpoint');
    if (ep.triggerType !== 'WEBHOOK') throw new AppError('CONFLICT', 'Only webhook endpoints have secrets');
    const value = kind === 'token' ? `mke_${randomToken(24)}` : `whsec_${randomToken(24)}`;
    await tx.emailEndpoint.update({
      where: { id },
      data: kind === 'token' ? { tokenHash: sha256(value), tokenPreview: `${value.slice(0, 8)}…${value.slice(-4)}` } : { signingSecretEnc: encrypt(value) },
    });
    await audit(tx, ctx, { action: `email.endpoint.${kind === 'token' ? 'token' : 'signing_secret'}_rotated`, targetType: 'email_endpoint', targetId: id, organizationId: null });
    return kind === 'token' ? { token: value } : { signingSecret: value };
  });
}

export async function deleteEndpoint(ctx: AuthContext, id: string) {
  assertCan(ctx, 'email.manage');
  const res = await withPlatform(async (tx) => {
    const ep = await tx.emailEndpoint.findFirst({ where: { id, deletedAt: null } });
    if (!ep) throw notFound('Endpoint');
    await tx.emailEndpoint.update({ where: { id }, data: { deletedAt: new Date(), status: 'PAUSED', tokenHash: null, slug: `${ep.slug}--deleted-${Date.now().toString(36)}` } });
    const cancelled = await tx.emailMessage.updateMany({ where: { endpointId: id, status: 'QUEUED' }, data: { status: 'CANCELLED', error: 'Endpoint deleted' } });
    await audit(tx, ctx, { action: 'email.endpoint.deleted', targetType: 'email_endpoint', targetId: id, organizationId: null, metadata: { name: ep.name, cancelledMessages: cancelled.count } });
    return { cancelled: cancelled.count };
  });
  invalidateActive();
  return res;
}

// ── Triggering ─────────────────────────────────────────────────────

type Recipient = { email: string; name: string | null };

function resolveRecipients(payload: unknown, cfg: EndpointConfig): Recipient[] {
  const out: Recipient[] = [];
  const add = (raw: unknown, name: unknown) => {
    const e = normalizeEmail(typeof raw === 'string' ? raw : null).value;
    if (e) out.push({ email: e, name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : null });
  };
  if (cfg.recipients.fromPayload && cfg.recipients.path) {
    const v = getPath(payload, cfg.recipients.path);
    const name = cfg.recipients.namePath ? getPath(payload, cfg.recipients.namePath) : null;
    const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;]/) : [v];
    for (const item of items) {
      if (item && typeof item === 'object') add((item as { email?: unknown }).email, (item as { name?: unknown }).name);
      else add(typeof item === 'string' ? item.trim() : item, items.length === 1 ? name : null);
    }
  }
  for (const f of cfg.recipients.fixed) add(f, null);
  const seen = new Set<string>();
  return out.filter((r) => !seen.has(r.email) && seen.add(r.email)).slice(0, cfg.recipients.max);
}

/** Turns one trigger into an event record and the scheduled messages it produces. */
export async function ingest(ep: EmailEndpoint, payload: unknown, o: { source: Source; ip?: string | null; idempotencyKey?: string | null; replayOfId?: string | null; testTo?: string[]; leadId?: string | null }): Promise<IngestResult> {
  const isTest = o.source === 'TEST';
  const storedPayload = (payload ?? {}) as Prisma.InputJsonValue;
  const record = async (status: string, reason: string | null) => {
    const ev = await withPlatform((tx) => tx.emailEndpointEvent.create({ data: { endpointId: ep.id, source: o.source, status, reason, payload: storedPayload, ip: o.ip ?? null, replayOfId: o.replayOfId ?? null } }));
    return { eventId: ev.id, status, reason, recipients: 0, messages: 0 };
  };
  const cfg = configOf(ep);
  if (!cfg) return record('REJECTED', 'The endpoint’s settings are invalid; open and save it again');
  if (ep.status === 'PAUSED' && !isTest) return record('PAUSED', 'Endpoint is paused');
  if (!isTest && o.source !== 'REPLAY') {
    const lim = await rateLimit(`ep-trigger:${ep.id}`, cfg.delivery.maxTriggersPerHour, 3600);
    if (!lim.ok) return record('THROTTLED', `More than ${cfg.delivery.maxTriggersPerHour} triggers in an hour`);
  }
  const fromPath = cfg.delivery.idempotencyPath ? getPath(payload, cfg.delivery.idempotencyPath) : null;
  const key = isTest || o.source === 'REPLAY' ? null : (o.idempotencyKey || (fromPath !== null && fromPath !== undefined && typeof fromPath !== 'object' ? String(fromPath) : '') || null)?.slice(0, 200) ?? null;
  if (key) {
    const dup = await withPlatform((tx) => tx.emailEndpointEvent.findUnique({ where: { endpointId_idempotencyKey: { endpointId: ep.id, idempotencyKey: key } }, select: { id: true } }));
    if (dup) return { ...(await record('DUPLICATE', `Already received as ${dup.id}`)), duplicateOf: dup.id };
  }
  if (!isTest && !evaluateConditions(payload, cfg.conditions)) return record('FILTERED', 'Conditions not met');

  let recipients = isTest && o.testTo?.length ? o.testTo.map((e) => ({ email: e.toLowerCase(), name: null })) : resolveRecipients(payload, cfg);
  let testNote: string | null = null;
  if (cfg.delivery.testMode && !isTest) {
    testNote = recipients.length ? `Test mode: would have gone to ${recipients.map((r) => maskEmail(r.email)).join(', ')}` : null;
    recipients = recipients.length ? cfg.delivery.testRecipients.map((e) => ({ email: e, name: recipients[0].name })) : [];
  }
  if (!recipients.length) return record('NO_RECIPIENTS', cfg.recipients.fromPayload ? `No valid email address at “${cfg.recipients.path}”` : 'No recipients configured');
  const steps = cfg.steps.map((s, index) => ({ ...s, index })).filter((s) => s.enabled);
  if (!steps.length) return record('REJECTED', 'No attached email is enabled');
  const sender = await resolveSender(ep);
  if (!sender) return record('REJECTED', 'No usable platform sender. Add one in Email → Senders.');
  const templates = new Map((await withPlatform((tx) => tx.emailTemplate.findMany({ where: { id: { in: steps.map((s) => s.templateId) } }, select: { id: true, subject: true, archivedAt: true } }))).map((t) => [t.id, t]));

  const vars = payloadVariables(payload, cfg.variables);
  const now = Date.now();
  try {
    const result = await withPlatform(async (tx) => {
      const ev = await tx.emailEndpointEvent.create({
        data: { endpointId: ep.id, source: o.source, status: 'ACCEPTED', idempotencyKey: key, payload: storedPayload, ip: o.ip ?? null, replayOfId: o.replayOfId ?? null, recipients: recipients.length },
      });
      const rows: Prisma.EmailMessageCreateManyInput[] = [];
      for (const r of recipients) {
        for (const s of steps) {
          const tpl = templates.get(s.templateId);
          let skip: string | null = !tpl || tpl.archivedAt ? 'The attached email template was deleted' : null;
          if (!skip && cfg.delivery.dedupeMinutes && !isTest) {
            const recent = await tx.emailMessage.findFirst({
              where: { endpointId: ep.id, stepIndex: s.index, toEmail: r.email, status: { in: ['QUEUED', 'SENDING', 'SENT'] }, createdAt: { gte: new Date(now - cfg.delivery.dedupeMinutes * 60_000) } },
              select: { id: true },
            });
            if (recent) skip = `Already emailed by this endpoint in the last ${cfg.delivery.dedupeMinutes} minutes`;
          }
          const at = isTest ? new Date(now) : nextInWindow(cfg.delivery.sendWindow, new Date(now + s.delayMinutes * 60_000));
          const names = splitName(r.name ?? '');
          rows.push({
            organizationId: null, endpointId: ep.id, endpointEventId: ev.id, stepIndex: s.index, smtpAccountId: sender.id,
            leadId: o.source === 'EVENT' ? (o.leadId ?? null) : null, toEmail: r.email, toName: r.name, subject: s.subject || tpl?.subject || '(no subject)',
            status: skip ? 'SKIPPED' : 'QUEUED', error: skip, trackingToken: randomToken(18), scheduledFor: at,
            vars: { ...vars, ...(r.name ? { fullName: r.name, firstName: names.firstName, lastName: names.lastName } : {}) } as Prisma.InputJsonValue,
            cc: cfg.recipients.cc, bcc: cfg.recipients.bcc,
          });
        }
      }
      const created = await tx.emailMessage.createManyAndReturn({ data: rows, select: { id: true, status: true, error: true, scheduledFor: true } });
      await tx.emailMessageEvent.createMany({
        data: created.map((m) => ({
          messageId: m.id, type: m.status === 'SKIPPED' ? 'SKIPPED' : 'QUEUED',
          detail: m.status === 'SKIPPED' ? m.error : [`Triggered by ${o.source.toLowerCase()}${m.scheduledFor && m.scheduledFor.getTime() > now + 1000 ? `; scheduled for ${m.scheduledFor.toISOString()}` : ''}`, testNote].filter(Boolean).join(' · '),
        })),
      });
      await tx.emailEndpointEvent.update({ where: { id: ev.id }, data: { messages: created.length } });
      await tx.emailEndpoint.update({ where: { id: ep.id }, data: { lastTriggeredAt: new Date() } });
      return { ev, created };
    }, { timeout: 60_000 });
    for (const m of result.created) if (m.status === 'QUEUED') await schedule(m.id, m.scheduledFor);
    return { eventId: result.ev.id, status: 'ACCEPTED', reason: testNote, recipients: recipients.length, messages: result.created.length };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && key) {
      const dup = await withPlatform((tx) => tx.emailEndpointEvent.findUnique({ where: { endpointId_idempotencyKey: { endpointId: ep.id, idempotencyKey: key } }, select: { id: true } }));
      return { ...(await record('DUPLICATE', `Already received as ${dup?.id ?? 'another request'}`)), duplicateOf: dup?.id };
    }
    throw err;
  }
}

async function schedule(messageId: string, at: Date | null, attempt = 0) {
  const delay = at ? Math.max(0, at.getTime() - Date.now()) : 0;
  // If Redis is unavailable the sweep picks the message up once it is due.
  await enqueue('email', 'endpoint-message', { messageId }, { jobId: `epmsg-${messageId}-${attempt}-${Date.now()}`, delay }).catch((err) => logger.warn({ err, messageId }, 'failed to enqueue endpoint message'));
}

async function hasActiveEndpoints(event: string) {
  const hit = activeCache.get(event);
  if (hit && Date.now() - hit.at < 10_000) return hit.active;
  const n = await withPlatform((tx) => tx.emailEndpoint.count({ where: { triggerType: 'EVENT', event, deletedAt: null } }));
  activeCache.set(event, { at: Date.now(), active: n > 0 });
  return n > 0;
}

/**
 * Fires a platform event at every endpoint listening for it. Cheap when nobody listens; never throws.
 * `key` makes the event idempotent per endpoint (a retried job cannot email twice).
 */
export async function emitEmailEvent(event: string, payload: Record<string, unknown>, key?: string) {
  try {
    if (!(await hasActiveEndpoints(event))) return;
    const job = await enqueue('email', 'endpoint-event', { event, payload, key: key ?? null }, key ? { jobId: `epev-${sha256(`${event}:${key}`).slice(0, 40)}` } : {});
    if (job === null) await handleEndpointEvent(event, payload, key ?? null);
  } catch (err) {
    logger.warn({ err, event }, 'failed to emit email event');
  }
}

/** Worker: delivers one platform event to its endpoints. */
export async function handleEndpointEvent(event: string, payload: Record<string, unknown>, key: string | null) {
  const eps = await withPlatform((tx) => tx.emailEndpoint.findMany({ where: { triggerType: 'EVENT', event, deletedAt: null } }));
  const leadId = typeof (payload.lead as { id?: unknown } | undefined)?.id === 'string' ? ((payload.lead as { id: string }).id) : null;
  const results: IngestResult[] = [];
  for (const ep of eps) results.push(await ingest(ep, payload, { source: 'EVENT', idempotencyKey: key ? `${event}:${key}` : null, leadId }));
  return results;
}

const leadPayload = (l: { id: string; fullName: string; email: string | null; emailNormalized: string | null; phone: string | null; company: string | null; jobTitle: string | null; city: string | null; state: string | null; country: string | null; industry: string | null; source: string | null; campaign: string | null; score: number }) => {
  const n = splitName(l.fullName);
  return { id: l.id, fullName: l.fullName, firstName: n.firstName, lastName: n.lastName, email: l.emailNormalized ?? l.email, phone: l.phone, company: l.company, jobTitle: l.jobTitle, city: l.city, state: l.state, country: l.country, industry: l.industry, source: l.source, campaign: l.campaign, score: l.score };
};

/** Called when an import completes: `import.completed` once, and `lead.created` for each inserted lead (in the worker). */
export async function emitImportEvents(importId: string) {
  try {
    const b = await withPlatform((tx) => tx.importBatch.findUnique({ where: { id: importId } }));
    if (!b) return;
    const by = await withPlatform((tx) => tx.user.findUnique({ where: { id: b.createdById }, select: { name: true, email: true } }));
    await emitEmailEvent('import.completed', {
      import: { id: b.id, code: b.code, fileName: b.fileName, source: b.source, campaign: b.campaign, inserted: b.insertedCount, updated: b.updatedCount, skipped: b.skippedCount, invalid: b.invalidCount },
      uploadedBy: by,
    }, importId);
    if (b.insertedCount > 0 && (await hasActiveEndpoints('lead.created'))) {
      const job = await enqueue('email', 'endpoint-import', { importId }, { jobId: `epimp-${importId}` });
      if (job === null) await handleImportLeadEvents(importId);
    }
  } catch (err) {
    logger.warn({ err, importId }, 'failed to emit import email events');
  }
}

/** Worker: `lead.created` for every lead an import inserted, in pages. Idempotent per lead. */
export async function handleImportLeadEvents(importId: string) {
  const eps = await withPlatform((tx) => tx.emailEndpoint.findMany({ where: { triggerType: 'EVENT', event: 'lead.created', deletedAt: null } }));
  if (!eps.length) return { leads: 0 };
  const b = await withPlatform((tx) => tx.importBatch.findUnique({ where: { id: importId }, select: { id: true, code: true, source: true } }));
  let cursor: string | undefined;
  let count = 0;
  for (;;) {
    const rows = await withPlatform((tx) => tx.importRow.findMany({ where: { importId, status: 'INSERTED', leadId: { not: null } }, orderBy: { id: 'asc' }, take: 500, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, leadId: true } }));
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    const leads = await withPlatform((tx) => tx.lead.findMany({ where: { id: { in: rows.map((r) => r.leadId!) }, archivedAt: null } }));
    for (const l of leads) {
      const payload = { lead: leadPayload(l), import: b };
      for (const ep of eps) await ingest(ep, payload, { source: 'EVENT', idempotencyKey: `lead.created:${l.id}`, leadId: l.id });
      count++;
    }
  }
  return { leads: count };
}

// ── Inbound webhooks ───────────────────────────────────────────────

function ipAllowed(ip: string | null, allowlist: string[]) {
  if (!allowlist.length) return true;
  if (!ip) return false;
  return allowlist.some((e) => (e.endsWith('*') ? ip.startsWith(e.slice(0, -1)) : ip === e));
}

/** Public: `POST /api/v1/public/email/:slug`. Token auth, optional HMAC signature and IP allowlist. */
export async function receiveWebhook(slug: string, raw: string, h: Headers, ip: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  if (raw.length > MAX_PAYLOAD_BYTES) return { status: 413, body: { error: 'Payload too large (max 256 KB)' } };
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return { status: 404, body: { error: 'Unknown endpoint' } };
  const ep = await withPlatform((tx) => tx.emailEndpoint.findFirst({ where: { slug, deletedAt: null, triggerType: 'WEBHOOK' } }));
  if (!ep || !ep.tokenHash) return { status: 404, body: { error: 'Unknown endpoint' } };
  const ipLim = await rateLimit(`ep-hook-ip:${ip ?? 'unknown'}`, 600, 60);
  if (!ipLim.ok) return { status: 429, body: { error: 'Too many requests' } };
  const auth = h.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : (h.get('x-endpoint-token') ?? '');
  if (!token || !safeEqual(sha256(token), ep.tokenHash)) return { status: 401, body: { error: 'Invalid or missing token' } };
  const cfg = configOf(ep);
  if (cfg && !ipAllowed(ip, cfg.webhook.ipAllowlist)) return { status: 403, body: { error: 'This IP address is not allowed' } };
  if (cfg?.webhook.requireSignature) {
    const sig = h.get('x-markeetor-signature') ?? '';
    const t = /t=(\d+)/.exec(sig)?.[1];
    const v1 = /v1=([a-f0-9]{64})/.exec(sig)?.[1];
    const secret = ep.signingSecretEnc ? decrypt(ep.signingSecretEnc) : null;
    if (!secret || !t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > 300 || !safeEqual(createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'), v1)) {
      return { status: 401, body: { error: 'Invalid or expired signature' } };
    }
  }
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return { status: 400, body: { error: 'Body must be JSON' } };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { status: 400, body: { error: 'Body must be a JSON object' } };
  const res = await ingest(ep, payload, { source: 'WEBHOOK', ip, idempotencyKey: h.get('idempotency-key')?.slice(0, 200) ?? null });
  const status = res.status === 'PAUSED' ? 423 : res.status === 'THROTTLED' ? 429 : res.status === 'DUPLICATE' ? 200 : 202;
  return { status, body: { id: res.eventId, status: res.status.toLowerCase(), reason: res.reason ?? undefined, recipients: res.recipients, messages: res.messages, duplicateOf: res.duplicateOf } };
}

// ── Delivery ───────────────────────────────────────────────────────

const clickSig = (token: string, url: string) => createHmac('sha256', LINK_SECRET()).update(`${token}\n${url}`).digest('base64url').slice(0, 22);

/** Rewrites http(s) links to go through the click tracker (unsubscribe links are left alone). */
export function trackLinks(html: string, token: string) {
  return html.replace(/href="(https?:\/\/[^"]+)"/g, (whole, href: string) => {
    const url = href.replace(/&amp;/g, '&');
    if (url.includes('/unsubscribe/')) return whole;
    return `href="${APP_URL()}/api/v1/email/c/${token}?u=${encodeURIComponent(url)}&amp;s=${clickSig(token, url)}"`;
  });
}

/** Public click tracker: verifies the link signature (no open redirect), records the click and returns the target. */
export async function recordClick(token: string, url: string, sig: string, meta: { ip?: string | null; userAgent?: string | null }) {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token) || !/^https?:\/\//.test(url) || !safeEqual(clickSig(token, url), sig)) return null;
  await withPlatform(async (tx) => {
    const m = await tx.emailMessage.findUnique({ where: { trackingToken: token }, select: { id: true, clickCount: true, clickedAt: true } });
    if (!m) return;
    await tx.emailMessage.update({ where: { id: m.id }, data: { clickCount: { increment: 1 }, ...(m.clickedAt ? {} : { clickedAt: new Date() }) } });
    if (m.clickCount < 50) await recordMessageEvent(m.id, { type: 'CLICKED', url, ip: meta.ip, userAgent: meta.userAgent }, tx);
  }).catch((err) => logger.warn({ err }, 'failed to record click'));
  return url;
}

const BACKOFF_MIN = [1, 5, 15];

/** Worker: sends one endpoint message, re-checking every rule at send time. Safe to call more than once. */
export async function sendEndpointMessage(messageId: string): Promise<{ status: string; detail?: string }> {
  // Claim: only one worker can move a message from QUEUED to SENDING.
  const claimed = await withPlatform((tx) => tx.emailMessage.updateMany({ where: { id: messageId, status: 'QUEUED', endpointId: { not: null }, OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date(Date.now() + 5000) } }] }, data: { status: 'SENDING', scheduledFor: new Date() } }));
  if (!claimed.count) return { status: 'noop' };
  const m = await withPlatform((tx) => tx.emailMessage.findUniqueOrThrow({ where: { id: messageId } }));
  const finish = async (status: 'SENT' | 'FAILED' | 'SKIPPED' | 'CANCELLED', detail: string | null, data: Prisma.EmailMessageUpdateInput = {}) => {
    await withPlatform(async (tx) => {
      await tx.emailMessage.update({ where: { id: m.id }, data: { status, error: status === 'SENT' ? null : detail, ...data } });
      await recordMessageEvent(m.id, { type: status, detail }, tx);
    });
    return { status, detail: detail ?? undefined };
  };
  const defer = async (at: Date, detail: string) => {
    await withPlatform(async (tx) => {
      await tx.emailMessage.update({ where: { id: m.id }, data: { status: 'QUEUED', scheduledFor: at } });
      await recordMessageEvent(m.id, { type: 'DEFERRED', detail: `${detail}; next try ${at.toISOString()}` }, tx);
    });
    await schedule(m.id, at, m.attempts);
    return { status: 'DEFERRED', detail };
  };

  const ep = await withPlatform((tx) => tx.emailEndpoint.findUnique({ where: { id: m.endpointId! } }));
  if (!ep || ep.deletedAt) return finish('CANCELLED', 'Endpoint deleted');
  const trigger = m.endpointEventId ? await withPlatform((tx) => tx.emailEndpointEvent.findUnique({ where: { id: m.endpointEventId! }, select: { source: true } })) : null;
  const isTest = trigger?.source === 'TEST';
  if (ep.status === 'PAUSED' && !isTest) return defer(new Date(Date.now() + 15 * 60_000), 'Endpoint is paused');
  const cfg = configOf(ep);
  if (!cfg) return finish('FAILED', 'The endpoint’s settings are invalid');
  if (!isTest) {
    const next = nextInWindow(cfg.delivery.sendWindow, new Date());
    if (next.getTime() > Date.now() + 1000) return defer(next, 'Outside the send window');
  }
  const step = cfg.steps[m.stepIndex ?? 0];
  const tpl = step ? await withPlatform((tx) => tx.emailTemplate.findFirst({ where: { id: step.templateId, archivedAt: null } })) : null;
  if (!step || !tpl) return finish('SKIPPED', 'The attached email template was deleted');

  const reasons = ep.category === 'MARKETING' ? undefined : { in: ['BOUNCED', 'MANUAL'] };
  const suppressed = await withPlatform((tx) => tx.emailSuppression.findFirst({ where: { organizationId: null, emailHash: sha256(m.toEmail), ...(reasons ? { reason: reasons } : {}) } }));
  if (suppressed) return finish('SKIPPED', suppressed.reason === 'UNSUBSCRIBED' ? 'Recipient unsubscribed' : `Address is suppressed (${suppressed.reason.toLowerCase()})`);
  if (cfg.delivery.frequencyCap.enabled && !isTest) {
    const sent = await withPlatform((tx) => tx.emailMessage.count({ where: { endpointId: ep.id, toEmail: m.toEmail, status: 'SENT', sentAt: { gte: new Date(Date.now() - cfg.delivery.frequencyCap.hours * 3600_000) } } }));
    if (sent >= cfg.delivery.frequencyCap.max) return finish('SKIPPED', `Frequency cap: ${cfg.delivery.frequencyCap.max} per ${cfg.delivery.frequencyCap.hours}h reached`);
  }

  const acc = (await withPlatform((tx) => tx.smtpAccount.findFirst({ where: { id: m.smtpAccountId, deletedAt: null, status: { not: 'FAILED' } } }))) ?? (await resolveSender(ep));
  if (!acc) return finish('FAILED', 'No usable sender (add or fix one in Email → Senders)');
  const minute = await rateLimit(`smtp-minute:${acc.id}`, acc.perMinuteLimit, 60);
  if (!minute.ok) return defer(new Date(Date.now() + Math.max(5, minute.resetSec) * 1000), `Sender ${acc.label} is at its per-minute limit`);
  const sentToday = await withPlatform((tx) => tx.emailMessage.count({ where: { smtpAccountId: acc.id, status: 'SENT', sentAt: { gte: new Date(Date.now() - 86400_000) } } }));
  if (sentToday >= acc.dailyLimit) return defer(new Date(Date.now() + 30 * 60_000), `Sender ${acc.label} reached its daily limit of ${acc.dailyLimit}`);

  const unsubscribeUrl = `${APP_URL()}/unsubscribe/${m.trackingToken}`;
  const vars: Variables = { ...senderVars(acc, process.env.PLATFORM_NAME ?? (await productName())), ...((m.vars as Variables | null) ?? {}), unsubscribeUrl };
  if (!vars.fullName && m.toName) Object.assign(vars, splitName(m.toName), { fullName: m.toName });
  const rendered = renderEmail(tpl.design as unknown as EmailDesign, { preheader: tpl.preheader, vars, trackingPixelUrl: cfg.delivery.trackOpens && trackingAllowed() ? `${APP_URL()}/api/v1/email/o/${m.trackingToken}` : null });
  // Redirect links to a non-public domain are a strong spam signal, so click tracking needs a public https APP_URL.
  const html = cfg.delivery.trackClicks && trackingAllowed() ? trackLinks(rendered.html, m.trackingToken) : rendered.html;
  const subject = `${isTest || cfg.delivery.testMode ? '[TEST] ' : ''}${renderSubject(step.subject || tpl.subject, vars)}`;

  let transport: Awaited<ReturnType<typeof transportFor>> | null = null;
  try {
    transport = await transportFor(acc);
    const info = await transport.sendMail({
      from: { name: acc.fromName, address: acc.fromEmail }, replyTo: cfg.recipients.replyTo ?? acc.replyTo ?? undefined,
      to: m.toName ? { name: m.toName, address: m.toEmail } : m.toEmail, cc: m.cc.length ? m.cc : undefined, bcc: m.bcc.length ? m.bcc : undefined,
      subject, html, text: rendered.text,
      headers: { 'X-Endpoint': ep.slug, ...bulkHeaders({ trackingToken: m.trackingToken, feedbackId: ep.slug, marketing: ep.category === 'MARKETING' }) },
    });
    const res = await finish('SENT', `Accepted by ${acc.label}${info.messageId ? ` · ${info.messageId}` : ''}`, { sentAt: new Date(), subject, providerMessageId: info.messageId ?? null, attempts: { increment: 1 }, smtpAccountId: acc.id });
    if (m.leadId) {
      await withPlatform((tx) => tx.activity.create({ data: { leadId: m.leadId, actorId: ep.createdById, type: ACTIVITY.CONTACT_LOGGED, verification: 'PROVIDER_VERIFIED', summary: `Email sent (${ep.name}): ${subject.slice(0, 100)}`, data: { messageId: m.id, endpointId: ep.id } } })).catch((err) => logger.warn({ err }, 'failed to log lead activity'));
    }
    return res;
  } catch (err) {
    const message = String((err as Error).message ?? err).slice(0, 300);
    const permanent = /^5\d\d/.test(String((err as { responseCode?: number }).responseCode ?? '')) || m.attempts + 1 > BACKOFF_MIN.length;
    if (permanent) return finish('FAILED', message, { attempts: { increment: 1 } });
    const at = new Date(Date.now() + BACKOFF_MIN[m.attempts] * 60_000);
    await withPlatform(async (tx) => {
      await tx.emailMessage.update({ where: { id: m.id }, data: { status: 'QUEUED', error: message, scheduledFor: at, attempts: { increment: 1 } } });
      await recordMessageEvent(m.id, { type: 'RETRY', detail: `${message}; retrying at ${at.toISOString()}` }, tx);
    });
    await schedule(m.id, at, m.attempts + 1);
    return { status: 'RETRY', detail: message };
  } finally {
    transport?.close();
  }
}

/**
 * Safety net, every minute: un-sticks messages interrupted mid-send and re-queues due messages whose
 * job was lost. `inline` sends them directly (used by tests and when the queue is unavailable).
 */
export async function sweepEndpointMessages(opts: { inline?: boolean; graceMs?: number } = {}) {
  const now = Date.now();
  const stuck = await withPlatform((tx) => tx.emailMessage.findMany({ where: { endpointId: { not: null }, status: 'SENDING', scheduledFor: { lt: new Date(now - 15 * 60_000) } }, select: { id: true }, take: 500 }));
  for (const s of stuck) {
    await withPlatform(async (tx) => {
      await tx.emailMessage.update({ where: { id: s.id }, data: { status: 'QUEUED' } });
      await recordMessageEvent(s.id, { type: 'RETRY', detail: 'Sending was interrupted; queued again' }, tx);
    });
  }
  const due = await withPlatform((tx) => tx.emailMessage.findMany({ where: { endpointId: { not: null }, status: 'QUEUED', scheduledFor: { lte: new Date(now - (opts.graceMs ?? 60_000)) } }, orderBy: { scheduledFor: 'asc' }, select: { id: true }, take: 500 }));
  for (const d of due) {
    if (opts.inline) await sendEndpointMessage(d.id);
    else await enqueue('email', 'endpoint-message', { messageId: d.id }, { jobId: `epmsg-${d.id}-sweep-${Math.floor(now / 60_000)}` }).catch(() => null);
  }
  return { unstuck: stuck.length, requeued: due.length };
}

/** Daily: erases trigger payloads and message variables past each endpoint's retention period. */
export async function purgeEndpointData() {
  const eps = await withPlatform((tx) => tx.emailEndpoint.findMany({ select: { id: true, config: true } }));
  let purged = 0;
  for (const ep of eps) {
    const days = configOf(ep)?.delivery.retentionDays ?? 30;
    const cutoff = new Date(Date.now() - days * 86400_000);
    await withPlatform(async (tx) => {
      const a = await tx.emailEndpointEvent.updateMany({ where: { endpointId: ep.id, createdAt: { lt: cutoff }, NOT: { payload: { equals: Prisma.DbNull } } }, data: { payload: Prisma.DbNull } });
      const b = await tx.emailMessage.updateMany({ where: { endpointId: ep.id, createdAt: { lt: cutoff }, status: { notIn: ['QUEUED', 'SENDING'] }, NOT: { vars: { equals: Prisma.DbNull } } }, data: { vars: Prisma.DbNull } });
      purged += a.count + b.count;
    });
  }
  return { purged };
}

// ── Admin actions: test, replay, trigger log ───────────────────────

export const testInput = z.object({ payload: z.record(z.string(), z.unknown()).optional(), to: z.array(z.string().trim().toLowerCase().email()).min(1).max(5).optional() });

/** Sends every attached email right now to the given addresses (default: you), using a sample or custom payload. */
export async function testEndpoint(ctx: AuthContext, id: string, input: z.infer<typeof testInput>) {
  assertCan(ctx, 'email.manage');
  const lim = await rateLimit(`ep-test:${ctx.user.id}`, 30, 3600);
  if (!lim.ok) throw new AppError('RATE_LIMITED', 'Test limit reached for this hour');
  const ep = await withPlatform((tx) => tx.emailEndpoint.findFirst({ where: { id, deletedAt: null } }));
  if (!ep) throw notFound('Endpoint');
  const payload = input.payload ?? ENDPOINT_EVENTS.find((e) => e.key === ep.event)?.sample ?? {};
  const res = await ingest(ep, payload, { source: 'TEST', testTo: input.to ?? [ctx.user.email] });
  const results = [];
  if (res.status === 'ACCEPTED') {
    const msgs = await withPlatform((tx) => tx.emailMessage.findMany({ where: { endpointEventId: res.eventId, status: 'QUEUED' }, select: { id: true, toEmail: true, stepIndex: true } }));
    for (const m of msgs) results.push({ to: m.toEmail, step: m.stepIndex, ...(await sendEndpointMessage(m.id)) });
  }
  await withPlatform((tx) => audit(tx, ctx, { action: 'email.endpoint.tested', targetType: 'email_endpoint', targetId: id, organizationId: null, metadata: { to: (input.to ?? [ctx.user.email]).map(maskEmail) } }));
  return { ...res, results };
}

export async function listEndpointEvents(ctx: AuthContext, id: string, params: { status?: string; page: number; pageSize: number }) {
  assertCan(ctx, 'email.manage');
  const where: Prisma.EmailEndpointEventWhereInput = { endpointId: id, ...(params.status ? { status: params.status } : {}) };
  const [total, rows] = await withPlatform((tx) => Promise.all([
    tx.emailEndpointEvent.count({ where }),
    tx.emailEndpointEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
  ]));
  return { total, rows };
}

export async function replayEvent(ctx: AuthContext, eventId: string) {
  assertCan(ctx, 'email.manage');
  const ev = await withPlatform((tx) => tx.emailEndpointEvent.findUnique({ where: { id: eventId }, include: { endpoint: true } }));
  if (!ev || ev.endpoint.deletedAt) throw notFound('Trigger');
  if (ev.payload === null) throw new AppError('PRECONDITION_FAILED', 'This trigger’s payload was erased by the retention policy and cannot be replayed');
  const res = await ingest(ev.endpoint, ev.payload, { source: 'REPLAY', replayOfId: ev.id });
  await withPlatform((tx) => audit(tx, ctx, { action: 'email.endpoint.replayed', targetType: 'email_endpoint_event', targetId: ev.id, organizationId: null, metadata: { newEventId: res.eventId, status: res.status } }));
  return res;
}

// ── Mail history ───────────────────────────────────────────────────

export const historyQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  endpointId: z.string().max(64).optional(),
  campaignId: z.string().max(64).optional(),
  kind: z.enum(['endpoint', 'campaign']).optional(),
  status: z.enum(['QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED']).optional(),
  engagement: z.enum(['opened', 'clicked', 'not_opened']).optional(),
  q: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
type HistoryQuery = z.infer<typeof historyQuery>;

function historyWhere(p: HistoryQuery): Prisma.EmailMessageWhereInput {
  const q = p.q?.trim();
  return {
    organizationId: null,
    ...(p.endpointId ? { endpointId: p.endpointId } : {}),
    ...(p.campaignId ? { campaignId: p.campaignId } : {}),
    ...(p.kind === 'endpoint' ? { endpointId: { not: null } } : p.kind === 'campaign' ? { campaignId: { not: null } } : {}),
    ...(p.status ? { status: p.status } : {}),
    ...(p.engagement === 'opened' ? { openedAt: { not: null } } : p.engagement === 'clicked' ? { clickedAt: { not: null } } : p.engagement === 'not_opened' ? { status: 'SENT', openedAt: null } : {}),
    ...(p.from || p.to ? { createdAt: { ...(p.from ? { gte: p.from } : {}), ...(p.to ? { lte: p.to } : {}) } } : {}),
    // A full address searches exactly (addresses are masked in the list); anything else searches name and subject.
    ...(q ? (q.includes('@') ? { toEmail: q.toLowerCase() } : { OR: [{ toName: { contains: q, mode: 'insensitive' } }, { subject: { contains: q, mode: 'insensitive' } }] }) : {}),
  };
}

async function sourceNames(rows: Pick<EmailMessage, 'endpointId' | 'campaignId'>[]) {
  const epIds = [...new Set(rows.map((r) => r.endpointId).filter(Boolean) as string[])];
  const cIds = [...new Set(rows.map((r) => r.campaignId).filter(Boolean) as string[])];
  const [eps, cs] = await withPlatform((tx) => Promise.all([
    tx.emailEndpoint.findMany({ where: { id: { in: epIds } }, select: { id: true, name: true } }),
    tx.emailCampaign.findMany({ where: { id: { in: cIds } }, select: { id: true, name: true } }),
  ]));
  return { eps: new Map(eps.map((e) => [e.id, e.name])), cs: new Map(cs.map((c) => [c.id, c.name])) };
}

export async function listHistory(ctx: AuthContext, p: HistoryQuery) {
  if (!can(ctx, 'email.send', 'email.manage')) throw new AppError('FORBIDDEN', 'You do not have permission to view email history');
  const where = historyWhere(p);
  const [total, rows, summary] = await withPlatform((tx) => Promise.all([
    tx.emailMessage.count({ where }),
    tx.emailMessage.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (p.page - 1) * p.pageSize, take: p.pageSize }),
    tx.emailMessage.groupBy({ by: ['status'], where, _count: { _all: true } }),
  ]));
  const [opened, clicked] = await withPlatform((tx) => Promise.all([
    tx.emailMessage.count({ where: { AND: [where, { openedAt: { not: null } }] } }),
    tx.emailMessage.count({ where: { AND: [where, { clickedAt: { not: null } }] } }),
  ]));
  const names = await sourceNames(rows);
  return {
    total,
    summary: { ...Object.fromEntries(summary.map((s) => [s.status, s._count._all])), opened, clicked },
    rows: rows.map((r) => ({
      id: r.id, toEmail: maskEmail(r.toEmail), toName: r.toName, subject: r.subject, status: r.status, error: r.error, attempts: r.attempts,
      createdAt: r.createdAt, scheduledFor: r.scheduledFor, sentAt: r.sentAt, openedAt: r.openedAt, openCount: r.openCount, clickedAt: r.clickedAt, clickCount: r.clickCount,
      source: r.endpointId ? { kind: 'endpoint' as const, id: r.endpointId, name: names.eps.get(r.endpointId) ?? 'Deleted endpoint' } : r.campaignId ? { kind: 'campaign' as const, id: r.campaignId, name: names.cs.get(r.campaignId) ?? 'Campaign' } : null,
    })),
  };
}

export async function getMessageDetail(ctx: AuthContext, id: string) {
  if (!can(ctx, 'email.send', 'email.manage')) throw new AppError('FORBIDDEN', 'You do not have permission to view email history');
  const m = await withPlatform((tx) => tx.emailMessage.findFirst({ where: { id, organizationId: null }, include: { events: { orderBy: { createdAt: 'asc' } } } }));
  if (!m) throw notFound('Email');
  const names = await sourceNames([m]);
  const reveal = can(ctx, 'leads.reveal');
  // Re-render what was sent (variables are kept for endpoint messages until the retention period ends).
  let preview: string | null = null;
  let trigger = null;
  if (m.endpointId) {
    const ep = await withPlatform((tx) => tx.emailEndpoint.findUnique({ where: { id: m.endpointId! } }));
    const step = ep ? configOf(ep)?.steps[m.stepIndex ?? 0] : null;
    const tpl = step ? await withPlatform((tx) => tx.emailTemplate.findUnique({ where: { id: step.templateId } })) : null;
    if (tpl && m.vars) preview = renderEmail(tpl.design as unknown as EmailDesign, { preheader: tpl.preheader, vars: { ...(m.vars as Variables), unsubscribeUrl: '#' } }).html;
    trigger = m.endpointEventId ? await withPlatform((tx) => tx.emailEndpointEvent.findUnique({ where: { id: m.endpointEventId! }, select: { id: true, source: true, status: true, createdAt: true, ip: true } })) : null;
  } else if (m.campaignId) {
    const c = await withPlatform((tx) => tx.emailCampaign.findUnique({ where: { id: m.campaignId! }, select: { design: true, preheader: true } }));
    if (c) preview = renderEmail(c.design as unknown as EmailDesign, { preheader: c.preheader, vars: { ...splitName(m.toName ?? ''), fullName: m.toName ?? '', unsubscribeUrl: '#' } }).html;
  }
  const { trackingToken: _t, vars: _v, ...rest } = m;
  return {
    ...rest, toEmail: reveal ? m.toEmail : maskEmail(m.toEmail), cc: reveal ? m.cc : m.cc.map((e) => maskEmail(e)), bcc: reveal ? m.bcc : m.bcc.map((e) => maskEmail(e)),
    source: m.endpointId ? { kind: 'endpoint', id: m.endpointId, name: names.eps.get(m.endpointId) ?? 'Deleted endpoint' } : m.campaignId ? { kind: 'campaign', id: m.campaignId, name: names.cs.get(m.campaignId) ?? 'Campaign' } : null,
    trigger, preview, canResend: Boolean(m.endpointId && m.vars && ['SENT', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(m.status)), canCancel: Boolean(m.endpointId && m.status === 'QUEUED'),
  };
}

export async function resendMessage(ctx: AuthContext, id: string) {
  assertCan(ctx, 'email.manage');
  const copy = await withPlatform(async (tx) => {
    const m = await tx.emailMessage.findFirst({ where: { id, organizationId: null } });
    if (!m) throw notFound('Email');
    if (!m.endpointId || !m.vars) throw new AppError('CONFLICT', 'Only endpoint emails whose details are still retained can be resent');
    if (!['SENT', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(m.status)) throw new AppError('CONFLICT', 'This email is still being processed');
    const n = await tx.emailMessage.create({
      data: {
        organizationId: null, endpointId: m.endpointId, endpointEventId: m.endpointEventId, stepIndex: m.stepIndex, smtpAccountId: m.smtpAccountId, leadId: m.leadId,
        toEmail: m.toEmail, toName: m.toName, subject: m.subject, status: 'QUEUED', trackingToken: randomToken(18), scheduledFor: new Date(), vars: m.vars as Prisma.InputJsonValue, cc: m.cc, bcc: m.bcc,
      },
    });
    await recordMessageEvent(m.id, { type: 'RESENT', detail: `Resent by ${ctx.user.name} as ${n.id}` }, tx);
    await recordMessageEvent(n.id, { type: 'QUEUED', detail: `Resend of ${m.id} by ${ctx.user.name}` }, tx);
    await audit(tx, ctx, { action: 'email.message.resent', targetType: 'email_message', targetId: m.id, organizationId: null, metadata: { newMessageId: n.id } });
    return n;
  });
  await schedule(copy.id, null);
  return { id: copy.id };
}

export async function cancelMessage(ctx: AuthContext, id: string) {
  assertCan(ctx, 'email.manage');
  return withPlatform(async (tx) => {
    const res = await tx.emailMessage.updateMany({ where: { id, organizationId: null, endpointId: { not: null }, status: 'QUEUED' }, data: { status: 'CANCELLED', error: `Cancelled by ${ctx.user.name}` } });
    if (!res.count) throw new AppError('CONFLICT', 'Only queued endpoint emails can be cancelled');
    await recordMessageEvent(id, { type: 'CANCELLED', detail: `Cancelled by ${ctx.user.name}` }, tx);
    await audit(tx, ctx, { action: 'email.message.cancelled', targetType: 'email_message', targetId: id, organizationId: null });
    return { ok: true };
  });
}

/** CSV of the filtered history (up to 50,000 rows). Full addresses need the lead export permission. */
export async function exportHistory(ctx: AuthContext, p: HistoryQuery) {
  if (!can(ctx, 'email.send', 'email.manage')) throw new AppError('FORBIDDEN', 'You do not have permission to export email history');
  const full = can(ctx, 'leads.export');
  const rows = await withPlatform((tx) => tx.emailMessage.findMany({ where: historyWhere(p), orderBy: { createdAt: 'desc' }, take: 50_000 }), { timeout: 60_000 });
  const names = await sourceNames(rows);
  await withPlatform((tx) => audit(tx, ctx, { action: 'email.history.exported', targetType: 'email_message', targetId: null, organizationId: null, metadata: { rows: rows.length, fullAddresses: full, filters: p } }));
  const iso = (d: Date | null) => (d ? d.toISOString() : '');
  return toCsv([
    ['Created', 'Recipient', 'Name', 'Subject', 'Status', 'Detail', 'Source', 'Scheduled', 'Sent', 'First opened', 'Opens', 'First clicked', 'Clicks', 'Attempts'],
    ...rows.map((r) => [
      iso(r.createdAt), full ? r.toEmail : maskEmail(r.toEmail), r.toName ?? '', r.subject, r.status, r.error ?? '',
      r.endpointId ? `Endpoint: ${names.eps.get(r.endpointId) ?? ''}` : r.campaignId ? `Campaign: ${names.cs.get(r.campaignId) ?? ''}` : '',
      iso(r.scheduledFor), iso(r.sentAt), iso(r.openedAt), r.openCount, iso(r.clickedAt), r.clickCount, r.attempts,
    ]),
  ]);
}

/** Templates, senders and the event catalog for the endpoint editor. */
export async function endpointOptions(ctx: AuthContext) {
  assertCan(ctx, 'email.manage');
  const [templates, senders] = await withPlatform((tx) => Promise.all([
    tx.emailTemplate.findMany({ where: { organizationId: null, archivedAt: null }, orderBy: { updatedAt: 'desc' }, select: { id: true, name: true, subject: true, updatedAt: true } }),
    tx.smtpAccount.findMany({ where: { organizationId: null, deletedAt: null }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], select: { id: true, label: true, fromEmail: true, status: true, isDefault: true } }),
  ]));
  return { templates, senders, events: ENDPOINT_EVENTS };
}
