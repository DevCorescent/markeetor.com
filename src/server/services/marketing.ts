import { createHmac, timingSafeEqual } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { filterSchema, type Filter } from '@/lib/filters';
import { blockedIn, DEFAULT_MARKETING, featuresFor, marketingSettingsSchema, quietWindow, renderMessage, type MarketingFeature, type MarketingSettings } from '@/lib/marketing';
import { aiStatus } from '../ai';
import { audit } from '../audit';
import { can, type AuthContext } from '../auth/context';
import { withPlatform, withTenant, type Tx } from '../db';
import { AppError, notFound } from '../errors';
import { logger } from '../logger';
import { redis } from '../redis';
import { getSetting, invalidateSetting } from '../settings';
import { chargeCredits } from './credits';
import { buildClientLeadWhere } from './lead-filters';
import { normalizePhone } from './normalize';
import { notifyPermission } from './notifications';

/**
 * Marketing core: platform controls, WhatsApp / SMS delivery (with consent, quiet hours, daily limits, blocked words
 * and credits), segments, broadcasts, the AI writer and analytics. Sequences, links and forms build on this.
 */

// ── Settings & access ──────────────────────────────────────────────

export async function getMarketing(): Promise<MarketingSettings> {
  const raw = await getSetting('marketing');
  const parsed = marketingSettingsSchema.safeParse({ ...DEFAULT_MARKETING, ...(raw as object) });
  return parsed.success ? parsed.data : DEFAULT_MARKETING;
}

export async function saveMarketing(ctx: AuthContext, input: MarketingSettings) {
  const value = marketingSettingsSchema.parse(input);
  const before = await getMarketing();
  await withPlatform(async (tx) => {
    await tx.platformSetting.upsert({ where: { key: 'marketing' }, create: { key: 'marketing', value: value as unknown as Prisma.InputJsonValue, updatedById: ctx.user.id }, update: { value: value as unknown as Prisma.InputJsonValue, updatedById: ctx.user.id } });
    await audit(tx, ctx, { action: 'settings.marketing.updated', targetType: 'platform_setting', targetId: 'marketing', organizationId: null, before, after: value });
  });
  invalidateSetting('marketing');
  return value;
}

export async function marketingAccess(orgId: string) {
  const s = await getMarketing();
  return { settings: s, features: featuresFor(s, orgId) };
}

export async function assertFeature(ctx: AuthContext, f: MarketingFeature) {
  const { settings, features } = await marketingAccess(ctx.orgId!);
  if (!features[f]) throw new AppError('FORBIDDEN', 'This marketing feature is not enabled for your workspace');
  return settings;
}

export function assertClean(text: string, s: MarketingSettings) {
  const w = blockedIn(text, s.moderation.blockedWords);
  if (w) throw new AppError('VALIDATION_FAILED', `“${w}” isn’t allowed in messages on this platform`);
}

// ── Delivery adapters ──────────────────────────────────────────────

type Sent = { status: 'SENT' | 'LOGGED'; provider: string; providerMessageId: string | null };

async function sendWhatsAppCloud(to: string, body: string): Promise<Sent> {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('WhatsApp Cloud API is not configured');
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST', signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'text', text: { body, preview_url: true } }),
  });
  const j = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(j.error?.message ?? `WhatsApp HTTP ${res.status}`);
  return { status: 'SENT', provider: 'whatsapp_cloud', providerMessageId: j.messages?.[0]?.id ?? null };
}

async function sendTwilioSms(to: string, body: string): Promise<Sent> {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !tok || !from) throw new Error('Twilio SMS is not configured');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  const j = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
  if (!res.ok) throw new Error(j.message ?? `Twilio HTTP ${res.status}`);
  return { status: 'SENT', provider: 'twilio', providerMessageId: j.sid ?? null };
}

export function channelReady(s: MarketingSettings, channel: 'WHATSAPP' | 'SMS') {
  const mode = channel === 'WHATSAPP' ? s.providers.whatsapp : s.providers.sms;
  if (mode === 'off') return { ok: false, mode, live: false };
  if (mode === 'log') return { ok: true, mode, live: false };
  const live = channel === 'WHATSAPP' ? Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) : Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
  return { ok: live, mode, live };
}

// ── Sending one message ────────────────────────────────────────────

const LINK_SECRET = () => process.env.SESSION_SECRET ?? process.env.APP_SECRET ?? 'leadscrm-links';
/** Per-lead click token so tracked links know who clicked (`<clientLeadId>.<8 hex>`). */
export const leadToken = (clientLeadId: string) => `${clientLeadId}.${createHmac('sha256', LINK_SECRET()).update(clientLeadId).digest('hex').slice(0, 8)}`;
export function leadFromToken(t: string | null | undefined) {
  if (!t) return null;
  const [id, sig] = t.split('.');
  if (!id || !sig) return null;
  const want = createHmac('sha256', LINK_SECRET()).update(id).digest('hex').slice(0, 8);
  return want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig)) ? id : null;
}
export const trackedUrl = (code: string, clientLeadId?: string | null) => `${process.env.APP_URL ?? ''}/l/${code}${clientLeadId ? `?t=${leadToken(clientLeadId)}` : ''}`;

export type SendResult = { status: 'SENT' | 'LOGGED' | 'SKIPPED' | 'FAILED' | 'DEFERRED'; reason?: string; retryAt?: Date; messageId?: string };

/**
 * Sends one WhatsApp / SMS message to a workspace lead, enforcing everything the platform controls:
 * feature switch, provider, opt-outs, quiet hours, daily limit, blocked words and credits.
 * DEFERRED means "try again at retryAt" (quiet hours or daily limit).
 */
export async function sendToLead(input: { organizationId: string; clientLeadId: string; channel: 'WHATSAPP' | 'SMS'; body: string; actorId: string; sequenceId?: string | null; enrollmentId?: string | null; broadcastId?: string | null; ignoreQuietHours?: boolean }): Promise<SendResult> {
  const { settings: s, features } = await marketingAccess(input.organizationId);
  if (!features[input.channel === 'WHATSAPP' ? 'whatsapp' : 'sms']) return { status: 'SKIPPED', reason: `${input.channel === 'WHATSAPP' ? 'WhatsApp' : 'SMS'} is not enabled for this workspace` };
  const ready = channelReady(s, input.channel);
  if (!ready.ok) return { status: 'SKIPPED', reason: ready.mode === 'off' ? 'Channel is switched off by the platform' : 'Channel provider is not configured' };
  if (!input.ignoreQuietHours) {
    const q = quietWindow(new Date(), s.quietHours);
    if (q.quiet) return { status: 'DEFERRED', reason: 'Quiet hours', retryAt: q.opensAt };
  }
  const o = s.overrides.find((x) => x.organizationId === input.organizationId);
  const limit = o?.messagesPerDay ?? s.limits.messagesPerDay;
  const dayKey = `mkt:sent:${input.organizationId}:${new Date().toISOString().slice(0, 10)}`;
  const used = Number(await redis().get(dayKey).catch(() => 0)) || 0;
  if (limit && used >= limit) { const t = new Date(); t.setUTCHours(24, 5, 0, 0); return { status: 'DEFERRED', reason: 'Daily message limit reached', retryAt: t }; }

  const prep = await withTenant(input.organizationId, async (tx) => {
    const lead = await tx.clientLead.findFirst({ where: { id: input.clientLeadId, organizationId: input.organizationId, revokedAt: null }, select: { id: true, fullName: true, company: true, city: true, phone: true, country: true } });
    if (!lead) return { skip: 'Lead not found' as string };
    const consent = await tx.consentRecord.findFirst({ where: { clientLeadId: lead.id, channel: input.channel }, orderBy: { createdAt: 'desc' }, select: { status: true } });
    if (consent?.status === 'OPTED_OUT') return { skip: `Lead opted out of ${input.channel === 'WHATSAPP' ? 'WhatsApp' : 'SMS'}` };
    const phone = normalizePhone(lead.phone, /united states|usa|canada/i.test(lead.country ?? '') ? 'US' : 'IN').value;
    if (!phone) return { skip: 'Lead has no valid phone number' };
    const [org, actor] = await Promise.all([
      withPlatform((p) => p.organization.findUnique({ where: { id: input.organizationId }, select: { name: true } })),
      withPlatform((p) => p.user.findUnique({ where: { id: input.actorId }, select: { name: true } })),
    ]);
    const text = renderMessage(input.body, { first_name: lead.fullName.split(/\s+/)[0], name: lead.fullName, company: lead.company, city: lead.city, sender_name: actor?.name ?? null, workspace: org?.name ?? null }, (code) => trackedUrl(code, lead.id));
    return { lead, phone, text };
  });
  const record = (data: Partial<Prisma.MarketingMessageUncheckedCreateInput>) => withPlatform((tx) => tx.marketingMessage.create({
    data: { organizationId: input.organizationId, clientLeadId: input.clientLeadId, channel: input.channel, to: data.to ?? '', body: data.body ?? input.body, status: data.status ?? 'SKIPPED', sequenceId: input.sequenceId ?? null, enrollmentId: input.enrollmentId ?? null, broadcastId: input.broadcastId ?? null, sentById: input.actorId, ...data },
  }));
  if ('skip' in prep) { await record({ status: 'SKIPPED', error: prep.skip }); return { status: 'SKIPPED', reason: prep.skip }; }
  const bad = blockedIn(prep.text, s.moderation.blockedWords);
  if (bad) { await record({ to: prep.phone, body: prep.text, status: 'SKIPPED', error: `Blocked word “${bad}”` }); return { status: 'SKIPPED', reason: `Blocked word “${bad}”` }; }

  const price = input.channel === 'WHATSAPP' ? s.pricing.whatsapp : s.pricing.sms;
  const paid = await withPlatform((tx) => chargeCredits(tx, input.organizationId, Math.ceil(price), `${input.channel === 'WHATSAPP' ? 'WhatsApp' : 'SMS'} to ${prep.lead.fullName}`, input.actorId));
  if (!paid) { await record({ to: prep.phone, body: prep.text, status: 'SKIPPED', error: 'Not enough credits' }); return { status: 'SKIPPED', reason: 'Not enough credits' }; }

  let sent: Sent;
  try {
    sent = ready.live ? (input.channel === 'WHATSAPP' ? await sendWhatsAppCloud(prep.phone, prep.text) : await sendTwilioSms(prep.phone, prep.text)) : { status: 'LOGGED', provider: 'log', providerMessageId: null };
  } catch (err) {
    // Refund a failed delivery.
    await withPlatform(async (tx) => { const { grantCredits } = await import('./credits'); await grantCredits(tx, input.organizationId, { type: 'REFUND', credits: Math.ceil(price), note: `${input.channel} not delivered` }); });
    const m = await record({ to: prep.phone, body: prep.text, status: 'FAILED', error: (err as Error).message.slice(0, 300) });
    return { status: 'FAILED', reason: (err as Error).message, messageId: m.id };
  }
  await redis().multi().incr(dayKey).expire(dayKey, 26 * 3600).exec().catch(() => null);
  const m = await record({ to: prep.phone, body: prep.text, status: sent.status, provider: sent.provider, providerMessageId: sent.providerMessageId, credits: Math.ceil(price) });
  await withTenant(input.organizationId, async (tx) => {
    await tx.communicationLog.create({ data: { organizationId: input.organizationId, clientLeadId: input.clientLeadId, userId: input.actorId, channel: input.channel, direction: 'OUTBOUND', outcome: 'SENT', body: prep.text.slice(0, 2000), verification: 'SYSTEM_VERIFIED', provider: sent.provider, providerMessageId: sent.providerMessageId } });
    await tx.clientLead.update({ where: { id: input.clientLeadId }, data: { lastActivityAt: new Date() } });
    await tx.clientLead.updateMany({ where: { id: input.clientLeadId, firstContactAt: null }, data: { firstContactAt: new Date() } });
  });
  return { status: sent.status, messageId: m.id };
}

/** Manual one-to-one send from a lead page. */
export const sendInput = z.object({ channel: z.enum(['WHATSAPP', 'SMS']), body: z.string().trim().min(1).max(1600) });
export async function sendFromLead(ctx: AuthContext, clientLeadId: string, input: z.infer<typeof sendInput>) {
  const s = await assertFeature(ctx, input.channel === 'WHATSAPP' ? 'whatsapp' : 'sms');
  assertClean(input.body, s);
  const visible = await withTenant(ctx.orgId!, (tx) => tx.clientLead.findFirst({ where: { id: clientLeadId, organizationId: ctx.orgId!, revokedAt: null, ...(can(ctx, 'crm.leads.read_all') ? {} : { ownerId: ctx.user.id }) }, select: { id: true } }));
  if (!visible) throw notFound('Lead');
  const r = await sendToLead({ organizationId: ctx.orgId!, clientLeadId, channel: input.channel, body: input.body, actorId: ctx.user.id, ignoreQuietHours: true });
  if (r.status === 'SKIPPED' || r.status === 'FAILED') throw new AppError('PRECONDITION_FAILED', r.reason ?? 'Message not sent');
  return r;
}

// ── Segments ───────────────────────────────────────────────────────

export const segmentInput = z.object({ name: z.string().trim().min(2).max(80), filter: filterSchema });

export const segmentWhere = (orgId: string, filter: Filter) => buildClientLeadWhere(orgId, filter, { view: 'active' });

export async function listSegments(ctx: AuthContext) {
  await assertFeature(ctx, 'segments');
  const rows = await withPlatform((tx) => tx.marketingSegment.findMany({ where: { organizationId: ctx.orgId! }, orderBy: { createdAt: 'desc' } }));
  const counts = await withTenant(ctx.orgId!, (tx) => Promise.all(rows.map((r) => tx.clientLead.count({ where: segmentWhere(ctx.orgId!, r.filter as Filter) }))));
  return rows.map((r, i) => ({ ...r, size: counts[i] }));
}

export async function saveSegment(ctx: AuthContext, id: string | null, input: z.infer<typeof segmentInput>) {
  const s = await assertFeature(ctx, 'segments');
  return withPlatform(async (tx) => {
    if (id) {
      const e = await tx.marketingSegment.findUnique({ where: { id } });
      if (!e || e.organizationId !== ctx.orgId) throw notFound('Segment');
      return tx.marketingSegment.update({ where: { id }, data: { name: input.name, filter: input.filter as Prisma.InputJsonValue } });
    }
    if ((await tx.marketingSegment.count({ where: { organizationId: ctx.orgId! } })) >= s.limits.segments) throw new AppError('CONFLICT', `You can keep up to ${s.limits.segments} segments`);
    const r = await tx.marketingSegment.create({ data: { organizationId: ctx.orgId!, name: input.name, filter: input.filter as Prisma.InputJsonValue, createdById: ctx.user.id } });
    await audit(tx, ctx, { action: 'marketing.segment.created', targetType: 'segment', targetId: r.id, metadata: { name: r.name } });
    return r;
  });
}

export async function deleteSegment(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const e = await tx.marketingSegment.findUnique({ where: { id } });
    if (!e || e.organizationId !== ctx.orgId) throw notFound('Segment');
    await tx.marketingSegment.delete({ where: { id } });
    return { ok: true };
  });
}

export async function segmentPreview(ctx: AuthContext, filter: Filter) {
  return withTenant(ctx.orgId!, async (tx) => {
    const where = segmentWhere(ctx.orgId!, filter);
    const [total, withPhone, withEmail] = await Promise.all([
      tx.clientLead.count({ where }), tx.clientLead.count({ where: { AND: [where, { NOT: { phone: null } }] } }), tx.clientLead.count({ where: { AND: [where, { NOT: { email: null } }] } }),
    ]);
    return { total, withPhone, withEmail };
  });
}

// ── Broadcasts ─────────────────────────────────────────────────────

export const broadcastInput = z.object({ name: z.string().trim().min(2).max(120), channel: z.enum(['WHATSAPP', 'SMS']), body: z.string().trim().min(1).max(1600), segmentId: z.string().min(1).max(64) });

export async function createBroadcast(ctx: AuthContext, input: z.infer<typeof broadcastInput>) {
  const s = await assertFeature(ctx, 'broadcasts');
  await assertFeature(ctx, input.channel === 'WHATSAPP' ? 'whatsapp' : 'sms');
  assertClean(input.body, s);
  const seg = await withPlatform((tx) => tx.marketingSegment.findUnique({ where: { id: input.segmentId } }));
  if (!seg || seg.organizationId !== ctx.orgId) throw notFound('Segment');
  const total = await withTenant(ctx.orgId!, (tx) => tx.clientLead.count({ where: { AND: [segmentWhere(ctx.orgId!, seg.filter as Filter), { NOT: { phone: null } }] } }));
  if (!total) throw new AppError('VALIDATION_FAILED', 'No leads with a phone number in this segment');
  const review = s.moderation.reviewBroadcastsAbove > 0 && total > s.moderation.reviewBroadcastsAbove;
  const b = await withPlatform(async (tx) => {
    const r = await tx.marketingBroadcast.create({ data: { organizationId: ctx.orgId!, name: input.name, channel: input.channel, body: input.body, segmentId: seg.id, total, status: review ? 'PENDING_REVIEW' : 'QUEUED', createdById: ctx.user.id } });
    await audit(tx, ctx, { action: 'marketing.broadcast.created', targetType: 'broadcast', targetId: r.id, metadata: { channel: r.channel, total, review } });
    return r;
  });
  if (review) await notifyPermission('email.manage', null, { type: 'MARKETING_REVIEW', title: `${ctx.org?.name ?? 'A client'} wants to broadcast to ${total} leads`, body: `${input.channel} · ${input.name}`, link: '/admin/marketing?tab=moderation' });
  return b;
}

export async function listBroadcasts(ctx: AuthContext) {
  return withPlatform((tx) => tx.marketingBroadcast.findMany({ where: { organizationId: ctx.orgId! }, orderBy: { createdAt: 'desc' }, take: 100 }));
}

export async function cancelBroadcast(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const b = await tx.marketingBroadcast.findUnique({ where: { id } });
    if (!b || (ctx.scope !== 'PLATFORM' && b.organizationId !== ctx.orgId)) throw notFound('Broadcast');
    if (!['PENDING_REVIEW', 'QUEUED', 'SENDING'].includes(b.status)) throw new AppError('CONFLICT', 'This broadcast has finished');
    return tx.marketingBroadcast.update({ where: { id }, data: { status: 'CANCELLED', completedAt: new Date() } });
  });
}

export async function reviewBroadcast(ctx: AuthContext, id: string, approve: boolean, note?: string) {
  return withPlatform(async (tx) => {
    const b = await tx.marketingBroadcast.findUnique({ where: { id } });
    if (!b) throw notFound('Broadcast');
    if (b.status !== 'PENDING_REVIEW') throw new AppError('CONFLICT', 'Not waiting for review');
    const u = await tx.marketingBroadcast.update({ where: { id }, data: { status: approve ? 'QUEUED' : 'REJECTED', reviewNote: note ?? null, ...(approve ? {} : { completedAt: new Date() }) } });
    await audit(tx, ctx, { action: `marketing.broadcast.${approve ? 'approved' : 'rejected'}`, targetType: 'broadcast', targetId: id, organizationId: b.organizationId, reason: note });
    await notifyPermission('crm.email.manage', b.organizationId, { type: 'MARKETING_REVIEW', title: `Broadcast “${b.name}” was ${approve ? 'approved' : 'not approved'}`, body: note ?? '', link: '/app/marketing?tab=broadcasts' }, tx);
    return u;
  });
}

/** Worker: sends queued broadcasts in batches (respects quiet hours and limits via sendToLead). */
export async function runBroadcasts(batch = 100) {
  const queued = await withPlatform((tx) => tx.marketingBroadcast.findMany({ where: { status: { in: ['QUEUED', 'SENDING'] } }, take: 10 }));
  for (const b of queued) {
    const seg = await withPlatform((tx) => tx.marketingSegment.findUnique({ where: { id: b.segmentId } }));
    if (!seg) { await withPlatform((tx) => tx.marketingBroadcast.update({ where: { id: b.id }, data: { status: 'CANCELLED', completedAt: new Date() } })); continue; }
    const leads = await withTenant(b.organizationId, (tx) => tx.clientLead.findMany({ where: { AND: [segmentWhere(b.organizationId, seg.filter as Filter), { NOT: { phone: null } }, ...(b.cursor ? [{ id: { gt: b.cursor } }] : [])] }, orderBy: { id: 'asc' }, take: batch, select: { id: true } }));
    if (!leads.length) { await withPlatform((tx) => tx.marketingBroadcast.update({ where: { id: b.id }, data: { status: 'COMPLETED', completedAt: new Date() } })); continue; }
    let sent = 0, failed = 0, skipped = 0, cursor = b.cursor;
    for (const l of leads) {
      const r = await sendToLead({ organizationId: b.organizationId, clientLeadId: l.id, channel: b.channel as 'WHATSAPP' | 'SMS', body: b.body, actorId: b.createdById, broadcastId: b.id });
      if (r.status === 'DEFERRED') break; // quiet hours / daily limit — resume later from this lead
      cursor = l.id;
      if (r.status === 'SENT' || r.status === 'LOGGED') sent++; else if (r.status === 'FAILED') failed++; else skipped++;
    }
    await withPlatform((tx) => tx.marketingBroadcast.update({ where: { id: b.id }, data: { status: 'SENDING', cursor, sent: { increment: sent }, failed: { increment: failed }, skipped: { increment: skipped } } }));
  }
}

// ── AI writer ──────────────────────────────────────────────────────

export const writeInput = z.object({
  kind: z.enum(['email', 'whatsapp', 'sms', 'linkedin', 'instagram', 'facebook_ad', 'google_ad']),
  topic: z.string().trim().min(3).max(600),
  tone: z.enum(['professional', 'friendly', 'persuasive', 'casual', 'urgent']).default('professional'),
  language: z.enum(['English', 'Hindi', 'Hinglish', 'Marathi', 'Tamil', 'Telugu', 'Gujarati', 'Bengali', 'Kannada']).default('English'),
  audience: z.string().trim().max(200).optional(),
});

const KIND_GUIDE: Record<z.infer<typeof writeInput>['kind'], string> = {
  email: 'a sales email with a short subject line (line 1: "Subject: …") and a 90–140 word body',
  whatsapp: 'a WhatsApp message under 60 words, warm and personal, one clear call to action',
  sms: 'an SMS under 155 characters with one call to action',
  linkedin: 'a LinkedIn post of 80–150 words with a hook first line and 3 relevant hashtags',
  instagram: 'an Instagram caption of 40–80 words with emojis and 5 hashtags',
  facebook_ad: 'a Facebook ad: primary text (≤ 125 chars), headline (≤ 40 chars) and description (≤ 30 chars), labelled',
  google_ad: 'a Google search ad: 3 headlines (≤ 30 chars each) and 2 descriptions (≤ 90 chars each), labelled',
};

function templateWrite(i: z.infer<typeof writeInput>, org: string) {
  const t = i.topic.replace(/\.$/, '');
  switch (i.kind) {
    case 'email': return `Subject: ${t.slice(0, 60)}\n\nHi {first_name|there},\n\nI’m {sender_name} from ${org}. ${t}.\n\nWe help businesses like {company|yours} get results quickly and without hassle. Would you be open to a 15-minute call this week?\n\nBest regards,\n{sender_name}\n${org}`;
    case 'whatsapp': return `Hi {first_name|there} 👋 This is {sender_name} from ${org}. ${t}. Would you like more details? Just reply here.`;
    case 'sms': return `${org}: ${t}. Reply YES for details. STOP to opt out`.slice(0, 160);
    case 'linkedin': return `${t}.\n\nAt ${org}, we see this every day — and the businesses that act early win.\n\nWhat’s your take? 👇\n\n#business #growth #sales`;
    case 'instagram': return `✨ ${t} ✨\n\nDM us or tap the link in bio to know more. 🚀\n\n#${org.replace(/\W/g, '')} #business #growth #smallbusiness #india`;
    case 'facebook_ad': return `Primary text: ${t.slice(0, 120)}\nHeadline: ${org.slice(0, 40)}\nDescription: Get started today`;
    case 'google_ad': return `Headline 1: ${org.slice(0, 30)}\nHeadline 2: ${t.slice(0, 30)}\nHeadline 3: Get a free quote\nDescription 1: ${t.slice(0, 90)}\nDescription 2: Trusted by businesses across India. Contact us today.`;
  }
}

export async function aiWrite(ctx: AuthContext, input: z.infer<typeof writeInput>) {
  const s = await assertFeature(ctx, 'aiWriter');
  const dayKey = `mkt:ai:${ctx.orgId}:${new Date().toISOString().slice(0, 10)}`;
  const used = await redis().incr(dayKey).catch(() => 1);
  if (used === 1) await redis().expire(dayKey, 26 * 3600).catch(() => null);
  if (s.limits.aiDraftsPerDay && used > s.limits.aiDraftsPerDay) { await redis().decr(dayKey).catch(() => null); throw new AppError('RATE_LIMITED', `Daily AI writing limit (${s.limits.aiDraftsPerDay}) reached`); }
  const org = await withPlatform((tx) => tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId! }, select: { name: true, industry: true } }));
  const ai = await aiStatus();
  let text: string | null = null;
  let engine: 'claude' | 'template' = 'template';
  if (ai.enabled && process.env.AI_PROVIDER_API_KEY) {
    const paid = await withPlatform((tx) => chargeCredits(tx, ctx.orgId!, Math.ceil(s.pricing.aiDraft), `AI writer: ${input.kind}`, ctx.user.id));
    if (!paid) throw new AppError('PRECONDITION_FAILED', `Not enough credits — AI writing costs ${s.pricing.aiDraft} credits per draft`);
    try {
      const client = new Anthropic({ apiKey: process.env.AI_PROVIDER_API_KEY });
      const res = await client.messages.create({
        model: process.env.AI_MODEL || 'claude-opus-5-5', max_tokens: 900,
        system: `You are a senior marketing copywriter for small and mid-sized businesses (mostly in India). Write ${KIND_GUIDE[input.kind]}. Tone: ${input.tone}. Language: ${input.language}${input.language === 'Hinglish' ? ' (Hindi in Latin script mixed with English)' : ''}. Business: ${org.name}${org.industry ? ` (${org.industry})` : ''}. Use merge tags where natural: {first_name|there}, {company}, {sender_name}. Never invent prices, statistics, awards or guarantees. No markdown headings. Return only the copy.`,
        messages: [{ role: 'user', content: `Topic / offer: ${input.topic}${input.audience ? `\nAudience: ${input.audience}` : ''}` }],
      });
      text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim() || null;
      engine = 'claude';
    } catch (err) {
      logger.warn({ err }, 'AI writer failed; using template');
      await withPlatform(async (tx) => { const { grantCredits } = await import('./credits'); await grantCredits(tx, ctx.orgId!, { type: 'REFUND', credits: Math.ceil(s.pricing.aiDraft), note: 'AI writer unavailable' }); });
    }
  }
  text ??= templateWrite(input, org.name);
  const flagged = blockedIn(text, s.moderation.blockedWords);
  return { text, engine, credits: engine === 'claude' ? s.pricing.aiDraft : 0, flagged };
}

// ── Analytics ──────────────────────────────────────────────────────

export async function marketingOverview(ctx: AuthContext, days = 30) {
  const since = new Date(Date.now() - days * 86400_000);
  const orgId = ctx.orgId!;
  const { settings, features } = await marketingAccess(orgId);
  return withPlatform(async (tx) => {
    const [byChannel, credits, seqs, enrollments, links, clicks, forms, subs, emailStats] = await Promise.all([
      tx.marketingMessage.groupBy({ by: ['channel', 'status'], where: { organizationId: orgId, createdAt: { gte: since } }, _count: true }),
      tx.marketingMessage.aggregate({ where: { organizationId: orgId, createdAt: { gte: since } }, _sum: { credits: true } }),
      tx.sequence.findMany({ where: { organizationId: orgId }, select: { id: true, name: true, status: true, enrolledCount: true } }),
      tx.sequenceEnrollment.groupBy({ by: ['sequenceId', 'status', 'stopReason'], where: { organizationId: orgId }, _count: true }),
      tx.trackedLink.findMany({ where: { organizationId: orgId }, orderBy: { clicks: 'desc' }, take: 5, select: { id: true, name: true, code: true, clicks: true, uniqueLeads: true } }),
      tx.linkClick.count({ where: { organizationId: orgId, createdAt: { gte: since } } }),
      tx.captureForm.findMany({ where: { organizationId: orgId }, select: { id: true, name: true, views: true, submissions: true, status: true } }),
      tx.captureSubmission.count({ where: { organizationId: orgId, createdAt: { gte: since } } }),
      tx.emailMessage.groupBy({ by: ['status'], where: { organizationId: orgId, createdAt: { gte: since } }, _count: true }),
    ]);
    const ch = (c: string) => Object.fromEntries(byChannel.filter((r) => r.channel === c).map((r) => [r.status, r._count]));
    return {
      days, features, pricing: settings.pricing, providers: { whatsapp: channelReady(settings, 'WHATSAPP'), sms: channelReady(settings, 'SMS') },
      quietHours: settings.quietHours,
      channels: { whatsapp: ch('WHATSAPP'), sms: ch('SMS'), email: Object.fromEntries(emailStats.map((r) => [r.status, r._count])) },
      creditsSpent: credits._sum.credits ?? 0, clicks, submissions: subs,
      sequences: seqs.map((q) => {
        const rows = enrollments.filter((e) => e.sequenceId === q.id);
        const n = (f: (e: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((a, e) => a + e._count, 0);
        return { ...q, active: n((e) => e.status === 'ACTIVE'), completed: n((e) => e.status === 'COMPLETED'), replied: n((e) => e.stopReason === 'replied'), converted: n((e) => e.stopReason === 'status:CONVERTED'), stopped: n((e) => e.status === 'STOPPED') };
      }),
      topLinks: links, forms,
    };
  });
}

/** Platform-wide marketing usage for the control centre. */
export async function marketingAdminOverview(days = 30) {
  const since = new Date(Date.now() - days * 86400_000);
  return withPlatform(async (tx) => {
    const [byChannel, byOrg, credits, seqs, forms, links, pending, broadcasts] = await Promise.all([
      tx.marketingMessage.groupBy({ by: ['channel', 'status'], where: { createdAt: { gte: since } }, _count: true }),
      tx.marketingMessage.groupBy({ by: ['organizationId'], where: { createdAt: { gte: since } }, _count: true, _sum: { credits: true }, orderBy: { _count: { organizationId: 'desc' } }, take: 15 }),
      tx.marketingMessage.aggregate({ where: { createdAt: { gte: since } }, _sum: { credits: true } }),
      tx.sequence.count({ where: { status: 'ACTIVE' } }),
      tx.captureForm.aggregate({ _sum: { submissions: true }, _count: true }),
      tx.trackedLink.aggregate({ _sum: { clicks: true }, _count: true }),
      tx.captureForm.findMany({ where: { status: 'PENDING_REVIEW' }, take: 50 }),
      tx.marketingBroadcast.findMany({ where: { status: 'PENDING_REVIEW' }, take: 50 }),
    ]);
    const orgs = await tx.organization.findMany({ where: { id: { in: [...new Set([...byOrg.map((o) => o.organizationId), ...pending.map((p) => p.organizationId), ...broadcasts.map((b) => b.organizationId)])] } }, select: { id: true, name: true } });
    const name = (id: string) => orgs.find((o) => o.id === id)?.name ?? '—';
    const failed = byChannel.filter((r) => r.status === 'FAILED').reduce((a, r) => a + r._count, 0);
    const total = byChannel.reduce((a, r) => a + r._count, 0);
    return {
      days, total, failed, deliveryRate: total ? Math.round(((total - failed) / total) * 1000) / 10 : null, creditsEarned: credits._sum.credits ?? 0,
      channels: byChannel.map((r) => ({ channel: r.channel, status: r.status, count: r._count })),
      clients: byOrg.map((o) => ({ organizationId: o.organizationId, name: name(o.organizationId), messages: o._count, credits: o._sum.credits ?? 0 })),
      activeSequences: seqs, forms: forms._count, submissions: forms._sum.submissions ?? 0, links: links._count, clicks: links._sum.clicks ?? 0,
      review: {
        forms: pending.map((f) => ({ id: f.id, name: f.name, slug: f.slug, organization: name(f.organizationId), config: f.config, createdAt: f.createdAt })),
        broadcasts: broadcasts.map((b) => ({ id: b.id, name: b.name, channel: b.channel, body: b.body, total: b.total, organization: name(b.organizationId), createdAt: b.createdAt })),
      },
    };
  });
}

// ── Inbound (WhatsApp Cloud webhook) ───────────────────────────────

const STOP_WORDS = /^\s*(stop|unsubscribe|stop all|opt out|cancel|band karo)\s*$/i;

/** Delivery statuses and replies from WhatsApp. Replies stop sequences; "STOP" opts the lead out. */
export async function handleWhatsAppWebhook(raw: string, signature: string | null) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !signature) throw new AppError('UNAUTHENTICATED', 'Invalid signature');
  const want = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  if (want.length !== signature.length || !timingSafeEqual(Buffer.from(want), Buffer.from(signature))) throw new AppError('UNAUTHENTICATED', 'Invalid signature');
  const body = JSON.parse(raw) as { entry?: { changes?: { value?: { statuses?: { id: string; status: string; errors?: { title?: string }[] }[]; messages?: { from: string; text?: { body?: string } }[] } }[] }[] };
  let updates = 0, replies = 0;
  for (const e of body.entry ?? []) for (const ch of e.changes ?? []) {
    for (const st of ch.value?.statuses ?? []) {
      const map: Record<string, string> = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };
      if (!map[st.status]) continue;
      await withPlatform((tx) => tx.marketingMessage.updateMany({ where: { providerMessageId: st.id }, data: { status: map[st.status], ...(st.status === 'failed' ? { error: st.errors?.[0]?.title ?? 'Failed' } : {}) } }));
      updates++;
    }
    for (const m of ch.value?.messages ?? []) {
      const phone = `+${m.from.replace(/^\+/, '')}`;
      const last = await withPlatform((tx) => tx.marketingMessage.findFirst({ where: { to: phone, channel: 'WHATSAPP', clientLeadId: { not: null } }, orderBy: { createdAt: 'desc' } }));
      if (!last?.clientLeadId) continue;
      const text = m.text?.body ?? '';
      await withTenant(last.organizationId, async (tx) => {
        await tx.communicationLog.create({ data: { organizationId: last.organizationId, clientLeadId: last.clientLeadId!, userId: last.sentById ?? '', channel: 'WHATSAPP', direction: 'INBOUND', outcome: 'REPLIED', body: text.slice(0, 2000), verification: 'SYSTEM_VERIFIED', provider: 'whatsapp_cloud' } });
        if (STOP_WORDS.test(text)) await tx.consentRecord.create({ data: { organizationId: last.organizationId, clientLeadId: last.clientLeadId!, channel: 'WHATSAPP', status: 'OPTED_OUT', source: 'WhatsApp reply', recordedById: last.sentById ?? '' } });
      });
      const { stopEnrollments } = await import('./sequences');
      await stopEnrollments(last.organizationId, last.clientLeadId, STOP_WORDS.test(text) ? 'opted_out' : 'replied');
      replies++;
    }
  }
  return { updates, replies };
}
