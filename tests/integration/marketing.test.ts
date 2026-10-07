import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CREDIT_SETTINGS } from '@/lib/credits';
import { DEFAULT_MARKETING, quietWindow, renderMessage, type MarketingSettings } from '@/lib/marketing';
import { DEFAULT_PRICING } from '@/lib/pricing';
import { withPlatform, withTenant } from '@/server/db';
import { createLink, linkQr, resolveLink, saveForm, submitCaptureForm } from '@/server/services/capture';
import { adjustCredits, creditSummary, saveCreditSettings } from '@/server/services/credits';
import { createLeadRequest, savePricing } from '@/server/services/marketplace';
import { aiWrite, createBroadcast, handleWhatsAppWebhook, leadToken, reviewBroadcast, runBroadcasts, saveMarketing, saveSegment, segmentPreview, sendToLead } from '@/server/services/marketing';
import { enroll, runSequences, saveSequence, setSequenceStatus } from '@/server/services/sequences';
import { ctxFor, ensureRoles, makeLeads, makeOrg, makeUser } from '../helpers';

let admin: Awaited<ReturnType<typeof ctxFor>>;
const settings: MarketingSettings = { ...DEFAULT_MARKETING, quietHours: { ...DEFAULT_MARKETING.quietHours, enabled: false }, pricing: { whatsapp: 1, sms: 2, aiDraft: 2 }, moderation: { ...DEFAULT_MARKETING.moderation, reviewBroadcastsAbove: 2, blockedWords: ['guaranteed'] } };

beforeAll(async () => {
  await ensureRoles();
  admin = await ctxFor((await makeUser('platform_owner', null)).id);
  await savePricing(admin, { ...DEFAULT_PRICING, basePrice: 1, freeLeadsPerClient: 50, autoApproveFree: true, dynamic: { ...DEFAULT_PRICING.dynamic, enabled: false } });
  await saveCreditSettings(admin, { ...DEFAULT_CREDIT_SETTINGS, welcomeCredits: 0, lowBalanceThreshold: 0, expiryDays: null });
  await saveMarketing(admin, settings);
});
afterAll(async () => {
  await saveMarketing(admin, DEFAULT_MARKETING);
  await savePricing(admin, DEFAULT_PRICING);
  await saveCreditSettings(admin, DEFAULT_CREDIT_SETTINGS);
});

async function workspace(credits = 100, leads = 3) {
  const org = await makeOrg();
  const owner = await makeUser('client_owner', org.id);
  const ctx = await ctxFor(owner.id);
  if (credits) await adjustCredits(admin, { organizationId: org.id, credits, reason: 'Test' });
  if (leads) await createLeadRequest(ctx, { selection: { mode: 'ids', ids: await makeLeads(leads, { industry: `Mkt-${Date.now()}` }) }, acceptCharges: true });
  const cls = await withTenant(org.id, (tx) => tx.clientLead.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } }));
  return { org, owner, ctx, cls };
}

describe('helpers', () => {
  it('renders merge tags and tracked links, and knows quiet hours', () => {
    expect(renderMessage('Hi {first_name|there}, {company} — {link:abc123}', { first_name: 'Asha', company: null }, (c) => `https://x/l/${c}`)).toBe('Hi Asha, — https://x/l/abc123');
    expect(renderMessage('Hi {first_name|there}!', {})).toBe('Hi there!');
    const night = new Date('2026-10-05T17:00:00Z'); // 22:30 IST
    expect(quietWindow(night, { enabled: true, start: 21, end: 9, timezone: 'Asia/Kolkata' }).quiet).toBe(true);
    expect(quietWindow(new Date('2026-10-05T06:00:00Z'), { enabled: true, start: 21, end: 9, timezone: 'Asia/Kolkata' }).quiet).toBe(false);
  });
});

describe('sending', () => {
  it('sends in log mode, charges credits and logs the contact; honours opt-outs, blocked words and balance', async () => {
    const { org, owner, cls } = await workspace(3);
    const r = await sendToLead({ organizationId: org.id, clientLeadId: cls[0].id, channel: 'WHATSAPP', body: 'Hi {first_name}', actorId: owner.id });
    expect(r.status).toBe('LOGGED');
    const m = await withPlatform((tx) => tx.marketingMessage.findFirstOrThrow({ where: { organizationId: org.id } }));
    expect(m).toMatchObject({ channel: 'WHATSAPP', credits: 1, status: 'LOGGED', body: `Hi ${cls[0].fullName.split(' ')[0]}` });
    expect(await withTenant(org.id, (tx) => tx.communicationLog.count({ where: { clientLeadId: cls[0].id, channel: 'WHATSAPP' } }))).toBe(1);
    await withTenant(org.id, (tx) => tx.consentRecord.create({ data: { organizationId: org.id, clientLeadId: cls[1].id, channel: 'SMS', status: 'OPTED_OUT', recordedById: owner.id } }));
    expect(await sendToLead({ organizationId: org.id, clientLeadId: cls[1].id, channel: 'SMS', body: 'Hi', actorId: owner.id })).toMatchObject({ status: 'SKIPPED', reason: expect.stringMatching(/opted out/) });
    expect(await sendToLead({ organizationId: org.id, clientLeadId: cls[2].id, channel: 'WHATSAPP', body: 'guaranteed returns', actorId: owner.id })).toMatchObject({ status: 'SKIPPED', reason: expect.stringMatching(/Blocked/) });
    // 2 credits left: an SMS (2) goes, the next one is refused.
    expect((await sendToLead({ organizationId: org.id, clientLeadId: cls[2].id, channel: 'SMS', body: 'Hi', actorId: owner.id })).status).toBe('LOGGED');
    expect(await sendToLead({ organizationId: org.id, clientLeadId: cls[2].id, channel: 'SMS', body: 'Hi', actorId: owner.id })).toMatchObject({ status: 'SKIPPED', reason: 'Not enough credits' });
    expect((await creditSummary(await ctxFor(owner.id))).balance).toBe(0);
  });

  it('can switch a channel off for one client', async () => {
    const { org, owner, cls } = await workspace(10, 1);
    await saveMarketing(admin, { ...settings, overrides: [{ organizationId: org.id, features: { whatsapp: false }, messagesPerDay: null }] });
    try {
      expect(await sendToLead({ organizationId: org.id, clientLeadId: cls[0].id, channel: 'WHATSAPP', body: 'Hi', actorId: owner.id })).toMatchObject({ status: 'SKIPPED', reason: expect.stringMatching(/not enabled/) });
    } finally { await saveMarketing(admin, settings); }
  });
});

describe('sequences', () => {
  it('runs steps in order, creates tasks and completes; stops when the lead replies', async () => {
    const { org, owner, ctx, cls } = await workspace(50, 2);
    const seq = await saveSequence(ctx, null, { name: 'Welcome', steps: [{ id: 's1', type: 'whatsapp', delayHours: 0, body: 'Hi {first_name}!' }, { id: 's2', type: 'task', delayHours: 0, title: 'Call them' }], stopOnReply: true, stopOnStatus: ['CONVERTED', 'LOST'], segmentId: null, autoEnroll: false });
    await expect(enroll(ctx, seq.id, { clientLeadIds: [cls[0].id] })).rejects.toThrow(/Activate/);
    await setSequenceStatus(ctx, seq.id, 'ACTIVE');
    expect(await enroll(ctx, seq.id, { clientLeadIds: cls.map((c) => c.id) })).toMatchObject({ enrolled: 2 });
    // Lead 2 replies before anything is sent.
    await withTenant(org.id, (tx) => tx.communicationLog.create({ data: { organizationId: org.id, clientLeadId: cls[1].id, userId: owner.id, channel: 'WHATSAPP', direction: 'INBOUND', outcome: 'REPLIED', occurredAt: new Date(Date.now() + 1000) } }));
    await runSequences(); await runSequences();
    const es = await withPlatform((tx) => tx.sequenceEnrollment.findMany({ where: { sequenceId: seq.id } }));
    expect(es.find((e) => e.clientLeadId === cls[0].id)).toMatchObject({ status: 'COMPLETED', stepIndex: 2 });
    expect(es.find((e) => e.clientLeadId === cls[1].id)).toMatchObject({ status: 'STOPPED', stopReason: 'replied' });
    expect(await withTenant(org.id, (tx) => tx.task.count({ where: { clientLeadId: cls[0].id, title: 'Call them' } }))).toBe(1);
    expect(await withPlatform((tx) => tx.marketingMessage.count({ where: { sequenceId: seq.id } }))).toBe(1);
  });
});

describe('segments & broadcasts', () => {
  it('previews a segment and holds big broadcasts for review', async () => {
    const { org, ctx, cls } = await workspace(50, 3);
    const seg = await saveSegment(ctx, null, { name: 'All', filter: { conditions: [] } });
    expect(await segmentPreview(ctx, { conditions: [] })).toMatchObject({ total: 3, withPhone: 3 });
    const b = await createBroadcast(ctx, { name: 'Offer', channel: 'SMS', body: 'Diwali offer for {company|you}', segmentId: seg.id });
    expect(b).toMatchObject({ status: 'PENDING_REVIEW', total: 3 });
    await runBroadcasts();
    expect((await withPlatform((tx) => tx.marketingBroadcast.findUniqueOrThrow({ where: { id: b.id } }))).sent).toBe(0);
    await reviewBroadcast(admin, b.id, true);
    await runBroadcasts(); await runBroadcasts();
    expect(await withPlatform((tx) => tx.marketingBroadcast.findUniqueOrThrow({ where: { id: b.id } }))).toMatchObject({ status: 'COMPLETED', sent: 3 });
    void org; void cls;
  });
});

describe('links, forms, AI writer, WhatsApp webhook', () => {
  it('tracks clicks per lead and makes QR codes', async () => {
    const { org, ctx, cls } = await workspace(0, 1);
    const l = await createLink(ctx, { name: 'Brochure', url: 'https://example.com/brochure', utmSource: 'whatsapp', utmCampaign: 'diwali' });
    const dest = await resolveLink(l.code, { token: leadToken(cls[0].id), userAgent: 'Mozilla/5.0' });
    expect(dest).toBe('https://example.com/brochure?utm_source=whatsapp&utm_campaign=diwali');
    await resolveLink(l.code, { token: 'forged.token', userAgent: 'Mozilla/5.0' });
    const after = await withPlatform((tx) => tx.trackedLink.findUniqueOrThrow({ where: { id: l.id } }));
    expect(after).toMatchObject({ clicks: 2, uniqueLeads: 1 });
    expect(await withTenant(org.id, (tx) => tx.activity.count({ where: { clientLeadId: cls[0].id, type: 'LINK_CLICKED' } }))).toBe(1);
    expect((await linkQr(ctx, l.id)).svg).toMatch(/^<svg/);
  });

  it('turns form submissions into workspace leads (deduplicated) and enrols them', async () => {
    const { org, ctx } = await workspace(20, 0);
    const seq = await saveSequence(ctx, null, { name: 'Form follow-up', steps: [{ id: 'a', type: 'task', delayHours: 0, title: 'Call new form lead' }], stopOnReply: true, stopOnStatus: ['CONVERTED'], segmentId: null, autoEnroll: false });
    await setSequenceStatus(ctx, seq.id, 'ACTIVE');
    const f = await saveForm(ctx, null, { name: 'Website contact', sequenceId: seq.id, status: 'ACTIVE', config: { title: 'Contact us', description: '', button: 'Send', thankYou: 'Thanks!', redirectUrl: null, consent: true, accent: '#111111', fields: [{ key: 'name', label: 'Name', type: 'text', required: true, options: [], mapTo: 'fullName' }, { key: 'phone', label: 'Phone', type: 'phone', required: true, options: [], mapTo: 'phone' }, { key: 'budget', label: 'Budget', type: 'text', required: false, options: [], mapTo: 'custom' }] } });
    await expect(submitCaptureForm(f.slug, { answers: { name: 'Ravi' }, consent: false }, { ip: null })).rejects.toThrow(/highlighted/);
    expect(await submitCaptureForm(f.slug, { answers: { name: 'Ravi Mehta', phone: '98200 12345', budget: '5L' }, consent: true }, { ip: null })).toMatchObject({ ok: true, thankYou: 'Thanks!' });
    await submitCaptureForm(f.slug, { answers: { name: 'Ravi M', phone: '+91 98200 12345' }, consent: true }, { ip: null });
    const leads = await withTenant(org.id, (tx) => tx.clientLead.findMany({ where: { organizationId: org.id, source: 'Lead form' } }));
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ fullName: 'Ravi Mehta', phone: '+919820012345', campaign: 'Website contact' });
    expect(leads[0].customFields).toMatchObject({ budget: '5L' });
    const master = await withPlatform((tx) => tx.lead.findUniqueOrThrow({ where: { id: leads[0].leadId } }));
    expect(master).toMatchObject({ allocationStatus: 'ALLOCATED', assignedOrganizationId: org.id }); // never sold in the marketplace
    expect(await withTenant(org.id, (tx) => tx.consentRecord.count({ where: { clientLeadId: leads[0].id, status: 'OPTED_IN' } }))).toBe(6);
    expect(await withPlatform((tx) => tx.sequenceEnrollment.count({ where: { sequenceId: seq.id } }))).toBe(1);
    expect((await withPlatform((tx) => tx.captureForm.findUniqueOrThrow({ where: { id: f.id } }))).submissions).toBe(2);
  });

  it('writes copy without AI and handles WhatsApp replies and STOP', async () => {
    const { org, owner, ctx, cls } = await workspace(20, 1);
    const w = await aiWrite(ctx, { kind: 'whatsapp', topic: 'Free solar site survey this week', tone: 'friendly', language: 'English' });
    expect(w).toMatchObject({ engine: 'template', credits: 0 });
    expect(w.text).toMatch(/solar site survey/i);
    process.env.WHATSAPP_APP_SECRET = 'app_secret_x';
    await sendToLead({ organizationId: org.id, clientLeadId: cls[0].id, channel: 'WHATSAPP', body: 'Hello', actorId: owner.id });
    const seq = await saveSequence(ctx, null, { name: 'Nurture', steps: [{ id: 'a', type: 'task', delayHours: 48, title: 'Later' }], stopOnReply: true, stopOnStatus: [], segmentId: null, autoEnroll: false });
    await setSequenceStatus(ctx, seq.id, 'ACTIVE');
    await enroll(ctx, seq.id, { clientLeadIds: [cls[0].id] });
    const msg = await withPlatform((tx) => tx.marketingMessage.findFirstOrThrow({ where: { organizationId: org.id } }));
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: msg.to.replace('+', ''), text: { body: 'STOP' } }] } }] }] });
    await expect(handleWhatsAppWebhook(raw, 'sha256=bad')).rejects.toThrow(/signature/);
    expect(await handleWhatsAppWebhook(raw, `sha256=${createHmac('sha256', 'app_secret_x').update(raw).digest('hex')}`)).toMatchObject({ replies: 1 });
    expect(await withTenant(org.id, (tx) => tx.consentRecord.findFirst({ where: { clientLeadId: cls[0].id, channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' } }))).toMatchObject({ status: 'OPTED_OUT' });
    expect(await withPlatform((tx) => tx.sequenceEnrollment.findFirstOrThrow({ where: { sequenceId: seq.id } }))).toMatchObject({ status: 'STOPPED', stopReason: 'opted_out' });
  });
});
