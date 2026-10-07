import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { defaultEndpointConfig, ENDPOINT_EVENTS, evaluateConditions, nextInWindow, payloadVariables, type EndpointInput } from '@/lib/email/endpoints';
import { DEFAULT_SETTINGS } from '@/lib/email/render';
import { withPlatform } from '@/server/db';
import { saveEmailTemplate, saveSmtpAccount } from '@/server/services/email';
import {
  cancelMessage, getMessageDetail, handleImportLeadEvents, listHistory, receiveWebhook, recordClick, replayEvent, resendMessage, saveEndpoint, sweepEndpointMessages, testEndpoint,
} from '@/server/services/endpoints';
import { configureImport, confirmImport, createImport, runProcessing, runValidation } from '@/server/services/imports';
import { ctxFor, ensureRoles, makeUser } from '../helpers';

const received: { to: string; raw: string }[] = [];
let server: SMTPServer;
let ownerId: string;
let templateId: string;
let senderId: string;

const decode = (raw: string) => raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
const headers = (h: Record<string, string>) => new Headers({ 'content-type': 'application/json', ...h });
const deliver = () => sweepEndpointMessages({ inline: true, graceMs: 0 });

async function webhookEndpoint(patch: (c: EndpointInput['config']) => void = () => {}, extra: Partial<EndpointInput> = {}) {
  const ctx = await ctxFor(ownerId);
  const config = defaultEndpointConfig();
  config.steps = [{ id: 's1', templateId, delayMinutes: 0, subject: null, enabled: true }];
  patch(config);
  const res = await saveEndpoint(ctx, null, { name: `Hook ${Math.random().toString(36).slice(2, 7)}`, description: null, status: 'ACTIVE', triggerType: 'WEBHOOK', event: null, category: 'TRANSACTIONAL', smtpAccountId: senderId, config, ...extra });
  return { slug: res.endpoint.slug, id: res.endpoint.id, token: res.token!, signingSecret: res.signingSecret };
}

beforeAll(async () => {
  await ensureRoles();
  ownerId = (await makeUser('platform_owner', null)).id;
  server = new SMTPServer({
    authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], logger: false,
    onAuth: (_a, _s, cb) => cb(null, { user: 'test' }),
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c.toString()));
      stream.on('end', () => {
        received.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.server.address() as { port: number }).port;
  const ctx = await ctxFor(ownerId);
  senderId = (await saveSmtpAccount(ctx, null, { label: 'Endpoints', host: '127.0.0.1', port, secure: false, username: 'u', password: 'p', fromName: 'markeetor', fromEmail: 'hello@platform.test', replyTo: null, dailyLimit: 1000, perMinuteLimit: 600, isDefault: false })).id;
  templateId = (await saveEmailTemplate(ctx, null, {
    name: 'Order confirmation', subject: 'Order {{orderId}} for {{firstName}}', preheader: null,
    design: { version: 1, settings: { ...DEFAULT_SETTINGS }, blocks: [
      { id: 'b1', type: 'text', align: 'left', html: '<p>Hi {{firstName}}, your plan is {{plan}} ({{planLabel}}).</p>' },
      { id: 'b2', type: 'button', label: 'View order', url: 'https://shop.example/orders?id=1&x=2', align: 'left', variant: 'solid', fullWidth: false },
      { id: 'b3', type: 'footer', html: '<p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>' },
    ] },
  } as never)).id;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('endpoint helpers', () => {
  it('flattens payload variables by name and path, with mappings and fallbacks', () => {
    const vars = payloadVariables({ email: 'a@b.co', lead: { company: 'Acme', address: { city: 'Pune' } }, company: 'Top' }, [{ name: 'region', path: 'lead.region', fallback: 'n/a' }]);
    expect(vars.company).toBe('Top');
    expect(vars.leadCompany).toBe('Acme');
    expect(vars.city).toBe('Pune');
    expect(vars.leadAddressCity).toBe('Pune');
    expect(vars.region).toBe('n/a');
  });

  it('evaluates conditions', () => {
    const p = { lead: { country: 'India', score: 72, tags: ['a'] } };
    expect(evaluateConditions(p, { match: 'all', rules: [{ path: 'lead.country', op: 'in', value: 'india, nepal' }, { path: 'lead.score', op: 'gte', value: '70' }] })).toBe(true);
    expect(evaluateConditions(p, { match: 'all', rules: [{ path: 'lead.score', op: 'lt', value: '50' }] })).toBe(false);
    expect(evaluateConditions(p, { match: 'any', rules: [{ path: 'lead.score', op: 'lt', value: '50' }, { path: 'lead.missing', op: 'not_exists', value: '' }] })).toBe(true);
  });

  it('moves sends into the send window', () => {
    const w = { enabled: true, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', timezone: 'UTC' };
    expect(nextInWindow(w, new Date('2026-10-07T10:00:00Z')).toISOString()).toBe('2026-10-07T10:00:00.000Z'); // Wednesday, inside
    expect(nextInWindow(w, new Date('2026-10-07T19:00:00Z')).toISOString()).toBe('2026-10-08T09:00:00.000Z'); // after hours → next morning
    expect(nextInWindow(w, new Date('2026-10-10T12:00:00Z')).toISOString()).toBe('2026-10-12T09:00:00.000Z'); // Saturday → Monday
  });
});

describe('webhook endpoints', () => {
  it('authenticates, renders payload variables, tracks clicks and logs history', async () => {
    const ep = await webhookEndpoint((c) => {
      c.recipients.path = 'customer.email';
      c.recipients.namePath = 'customer.name';
      c.recipients.cc = ['team@platform.test'];
      c.variables = [{ name: 'planLabel', path: 'plan', fallback: '' }];
      c.delivery.idempotencyPath = 'orderId';
      c.conditions.rules = [{ path: 'plan', op: 'neq', value: 'free' }];
    });
    const body = JSON.stringify({ orderId: 'A-1', plan: 'Pro', customer: { email: 'Buyer@Example.com', name: 'Jordan Rivera' } });
    expect((await receiveWebhook(ep.slug, body, headers({ authorization: 'Bearer wrong' }), '1.2.3.4')).status).toBe(401);
    const ok = await receiveWebhook(ep.slug, body, headers({ authorization: `Bearer ${ep.token}` }), '1.2.3.4');
    expect([ok.status, ok.body.status, ok.body.messages]).toEqual([202, 'accepted', 1]);

    received.length = 0;
    await deliver();
    expect(received).toHaveLength(1);
    expect(received[0].to).toContain('buyer@example.com');
    expect(received[0].to).toContain('team@platform.test');
    const raw = decode(received[0].raw);
    expect(raw).toContain('Subject: Order A-1 for Jordan');
    expect(raw).toContain('your plan is Pro (Pro)');
    const link = /href="(http:\/\/localhost:3100\/api\/v1\/email\/c\/[^"]+)"/.exec(raw)?.[1].replace(/&amp;/g, '&');
    expect(link).toBeTruthy();
    const u = new URL(link!);
    const token = u.pathname.split('/').pop()!;
    expect(await recordClick(token, u.searchParams.get('u')!, u.searchParams.get('s')!, {})).toBe('https://shop.example/orders?id=1&x=2');
    expect(await recordClick(token, 'https://evil.example', u.searchParams.get('s')!, {})).toBeNull();

    // Same order again → duplicate; free plan → filtered by the condition.
    const dup = await receiveWebhook(ep.slug, body, headers({ authorization: `Bearer ${ep.token}` }), null);
    expect([dup.status, dup.body.status]).toEqual([200, 'duplicate']);
    const free = await receiveWebhook(ep.slug, JSON.stringify({ orderId: 'A-2', plan: 'free', customer: { email: 'x@example.com' } }), headers({ authorization: `Bearer ${ep.token}` }), null);
    expect(free.body.status).toBe('filtered');

    const ctx = await ctxFor(ownerId);
    const hist = await listHistory(ctx, { page: 1, pageSize: 50, endpointId: ep.id });
    expect(hist.total).toBe(1);
    expect(hist.rows[0].clickCount).toBe(1);
    const detail = await getMessageDetail(ctx, hist.rows[0].id);
    expect(detail.events.map((e) => e.type)).toEqual(['QUEUED', 'SENT', 'CLICKED']);
    expect(detail.preview).toContain('your plan is Pro');
    const again = await resendMessage(ctx, hist.rows[0].id);
    await deliver();
    expect((await withPlatform((tx) => tx.emailMessage.findUniqueOrThrow({ where: { id: again.id } }))).status).toBe('SENT');
  });

  it('enforces signatures when required', async () => {
    const ep = await webhookEndpoint((c) => { c.webhook.requireSignature = true; });
    expect(ep.signingSecret).toMatch(/^whsec_/);
    const body = JSON.stringify({ email: 'signed@example.com' });
    expect((await receiveWebhook(ep.slug, body, headers({ authorization: `Bearer ${ep.token}` }), null)).status).toBe(401);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', ep.signingSecret!).update(`${t}.${body}`).digest('hex');
    const res = await receiveWebhook(ep.slug, body, headers({ authorization: `Bearer ${ep.token}`, 'x-markeetor-signature': `t=${t},v1=${sig}` }), null);
    expect(res.status).toBe(202);
  });

  it('schedules delayed emails, honours frequency caps, test mode and pausing', async () => {
    const ctx = await ctxFor(ownerId);
    const delayed = await webhookEndpoint((c) => { c.steps[0].delayMinutes = 120; });
    await receiveWebhook(delayed.slug, JSON.stringify({ email: 'later@example.com' }), headers({ authorization: `Bearer ${delayed.token}` }), null);
    await deliver();
    const queued = await withPlatform((tx) => tx.emailMessage.findFirstOrThrow({ where: { endpointId: delayed.id } }));
    expect(queued.status).toBe('QUEUED');
    expect(queued.scheduledFor!.getTime()).toBeGreaterThan(Date.now() + 110 * 60_000);
    await cancelMessage(ctx, queued.id);

    const capped = await webhookEndpoint((c) => { c.delivery.frequencyCap = { enabled: true, max: 1, hours: 24 }; });
    for (let i = 0; i < 2; i++) {
      await receiveWebhook(capped.slug, JSON.stringify({ email: 'capped@example.com' }), headers({ authorization: `Bearer ${capped.token}` }), null);
      await deliver();
    }
    const statuses = (await withPlatform((tx) => tx.emailMessage.findMany({ where: { endpointId: capped.id }, orderBy: { createdAt: 'asc' } }))).map((m) => m.status);
    expect(statuses).toEqual(['SENT', 'SKIPPED']);

    const testing = await webhookEndpoint((c) => { c.delivery.testMode = true; c.delivery.testRecipients = ['qa@platform.test']; });
    received.length = 0;
    await receiveWebhook(testing.slug, JSON.stringify({ email: 'real-customer@example.com' }), headers({ authorization: `Bearer ${testing.token}` }), null);
    await deliver();
    expect(received.map((r) => r.to)).toEqual(['qa@platform.test']);
    expect(decode(received[0].raw)).toContain('Subject: [TEST]');

    const paused = await webhookEndpoint(() => {}, { status: 'PAUSED' });
    expect((await receiveWebhook(paused.slug, JSON.stringify({ email: 'p@example.com' }), headers({ authorization: `Bearer ${paused.token}` }), null)).status).toBe(423);
  });

  it('sends a test to the admin and can replay a trigger', async () => {
    const ctx = await ctxFor(ownerId);
    const ep = await webhookEndpoint();
    received.length = 0;
    const t = await testEndpoint(ctx, ep.id, { payload: { email: 'ignored@example.com', plan: 'Pro' }, to: ['admin-test@platform.test'] });
    expect(t.results.map((r) => r.status)).toEqual(['SENT']);
    expect(received.map((r) => r.to)).toEqual(['admin-test@platform.test']);
    const first = await receiveWebhook(ep.slug, JSON.stringify({ email: 'replay@example.com' }), headers({ authorization: `Bearer ${ep.token}` }), null);
    const replay = await replayEvent(ctx, first.body.id as string);
    expect(replay.status).toBe('ACCEPTED');
    await deliver();
    expect(await withPlatform((tx) => tx.emailMessage.count({ where: { endpointId: ep.id, toEmail: 'replay@example.com', status: 'SENT' } }))).toBe(2);
  });
});

describe('event endpoints', () => {
  it('emails every lead an import adds, once', async () => {
    const ctx = await ctxFor(ownerId);
    const config = defaultEndpointConfig(ENDPOINT_EVENTS[0]);
    config.steps = [{ id: 's1', templateId, delayMinutes: 0, subject: 'Welcome {{firstName}} from {{company}}', enabled: true }];
    config.conditions.rules = [{ path: 'lead.source', op: 'eq', value: 'Fair' }];
    const ep = (await saveEndpoint(ctx, null, { name: 'New lead hello', description: null, status: 'ACTIVE', triggerType: 'EVENT', event: 'lead.created', category: 'MARKETING', smtpAccountId: senderId, config })).endpoint;

    const stamp = Date.now();
    const csv = ['Name,Email,Company', `Lena Lead,lena-${stamp}@example.com,Lena Co`, `Max Lead,max-${stamp}@example.com,Max Co`].join('\n');
    const { import: imp } = await createImport(ctx, { name: 'fair.csv', size: csv.length, buffer: Buffer.from(csv) });
    await configureImport(ctx, imp.id, { mapping: { Name: 'fullName', Email: 'email', Company: 'company' }, options: { dedupeKeys: ['email'], onDuplicate: 'skip', requireName: true, requireContact: true, requireEmail: false, requirePhone: false, defaultCountry: 'US', autoConfirm: false }, tags: [], source: 'Fair' });
    await runValidation(imp.id);
    await confirmImport(ctx, imp.id);
    await runProcessing(imp.id);

    received.length = 0;
    await deliver();
    expect(received.map((r) => r.to).sort()).toEqual([`lena-${stamp}@example.com`, `max-${stamp}@example.com`]);
    expect(decode(received.find((r) => r.to.startsWith('lena'))!.raw)).toContain('Subject: Welcome Lena from Lena Co');
    expect(decode(received[0].raw)).toMatch(/List-Unsubscribe/);

    // A retried job never emails twice.
    await handleImportLeadEvents(imp.id);
    const events = await withPlatform((tx) => tx.emailEndpointEvent.groupBy({ by: ['status'], where: { endpointId: ep.id }, _count: { _all: true } }));
    expect(Object.fromEntries(events.map((e) => [e.status, e._count._all]))).toEqual({ ACCEPTED: 2, DUPLICATE: 2 });
    const lead = await withPlatform((tx) => tx.lead.findFirstOrThrow({ where: { emailNormalized: `lena-${stamp}@example.com` } }));
    expect(await withPlatform((tx) => tx.activity.count({ where: { leadId: lead.id, summary: { contains: 'New lead hello' } } }))).toBe(1);
  });
});
