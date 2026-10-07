import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { GET as smtpListGET } from '@/app/api/v1/email/smtp/route';
import { GET as campaignGET } from '@/app/api/v1/email/campaigns/[id]/route';
import { PRESETS } from '@/lib/email/presets';
import type { EmailDesign } from '@/lib/email/types';
import { withPlatform, withTenant } from '@/server/db';
import { createCampaign, designSchema, listMessages, runCampaign, sanitizeEmailHtml, saveSmtpAccount, trackOpen, unsubscribe, verifySmtpAccount } from '@/server/services/email';
import { createDistribution, executeBatch } from '@/server/services/distribution';
import { cookieFor, ctxFor, ensureRoles, makeLeads, makeOrg, makeUser, params, req } from '../helpers';

const received: { to: string; subject: string; raw: string }[] = [];
let server: SMTPServer;
let port = 0;
let owner: { id: string };

beforeAll(async () => {
  await ensureRoles();
  owner = await makeUser('platform_owner', null);
  server = new SMTPServer({
    authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], logger: false,
    onAuth: (_a, _s, cb) => cb(null, { user: 'test' }),
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c.toString()));
      stream.on('end', () => {
        received.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), subject: /Subject: (.*)/.exec(raw)?.[1] ?? '', raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const design = (): EmailDesign => designSchema.parse(PRESETS[0].design()) as EmailDesign;
const account = (overrides = {}) => ({ label: 'Local', host: '127.0.0.1', port, secure: false, username: 'u', password: 'p', fromName: 'Platform', fromEmail: 'noreply@platform.test', replyTo: null, dailyLimit: 1000, perMinuteLimit: 600, isDefault: true, ...overrides });

describe('email campaigns', () => {
  it('verifies an SMTP sender and never exposes its password', async () => {
    const ctx = await ctxFor(owner.id);
    const acc = await saveSmtpAccount(ctx, null, account());
    expect('passwordEnc' in acc).toBe(false);
    expect((await verifySmtpAccount(ctx, acc.id)).ok).toBe(true);
    const list = await (await smtpListGET(req('/x', { cookie: await cookieFor(owner.id) }))).json();
    expect(JSON.stringify(list)).not.toMatch(/passwordEnc|"password"/);
  });

  it('sends personalised emails, logs every recipient, tracks opens and honours unsubscribes', async () => {
    const ctx = await ctxFor(owner.id);
    const acc = await saveSmtpAccount(ctx, null, account({ label: 'Second', isDefault: false }));
    const ids = await makeLeads(3);
    await withPlatform((tx) => tx.lead.update({ where: { id: ids[2] }, data: { email: null, emailNormalized: null } }));
    received.length = 0;
    const c = await createCampaign(ctx, { name: 'Test', smtpAccountId: acc.id, subject: 'Hello {{firstName}}', preheader: null, design: design() as never, audience: { kind: 'platform', selection: { mode: 'ids', ids } }, trackOpens: true, confirmLarge: false });
    expect(c.totalRecipients).toBe(3);
    expect(c.skippedCount).toBe(1);
    const done = await runCampaign(c.id);
    expect(done?.status).toBe('COMPLETED');
    expect(done?.sentCount).toBe(2);
    expect(received).toHaveLength(2);
    expect(received[0].subject).toBe('Hello Lead');
    expect(received[0].raw).toMatch(/List-Unsubscribe/);
    const log = await listMessages(ctx, { campaignId: c.id, page: 1, pageSize: 10 });
    expect(log.rows.every((m) => m.toEmail === null || m.toEmail.includes('•') || m.toEmail === '')).toBe(true);
    const msg = await withPlatform((tx) => tx.emailMessage.findFirstOrThrow({ where: { campaignId: c.id, status: 'SENT' } }));
    await trackOpen(msg.trackingToken);
    expect((await withPlatform((tx) => tx.emailCampaign.findUniqueOrThrow({ where: { id: c.id } }))).openedCount).toBe(1);
    await unsubscribe(msg.trackingToken);
    const again = await createCampaign(ctx, { name: 'Again', smtpAccountId: acc.id, subject: 'Hi', preheader: null, design: design() as never, audience: { kind: 'platform', selection: { mode: 'ids', ids: ids.slice(0, 2) } }, trackOpens: false, confirmLarge: false });
    expect(again.skippedCount).toBe(1);
  });

  it('sanitises template HTML', () => {
    const dirty = '<p onclick="x()">Hi <a href="javascript:alert(1)">x</a><script>alert(1)</script><a href="{{unsubscribeUrl}}">u</a></p>';
    const clean = sanitizeEmailHtml(dirty);
    expect(clean).not.toMatch(/onclick|javascript:|<script/);
    expect(clean).toContain('href="{{unsubscribeUrl}}"');
  });
});

describe('workspace email isolation', () => {
  it('blocks SMTP hosts on private networks for workspaces (SSRF)', async () => {
    const org = await makeOrg();
    const admin = await makeUser('client_owner', org.id);
    await expect(saveSmtpAccount(await ctxFor(admin.id), null, account())).rejects.toThrow(/private|loopback/);
  });

  it('keeps senders and campaigns tenant-private and skips opted-out leads', async () => {
    process.env.SMTP_ALLOW_PRIVATE_HOSTS = 'true';
    try {
      const [a, b] = [await makeOrg(), await makeOrg()];
      const ownerA = await makeUser('client_owner', a.id);
      const ownerB = await makeUser('client_owner', b.id);
      const ctxA = await ctxFor(ownerA.id);
      const acc = await saveSmtpAccount(ctxA, null, account({ fromEmail: 'sales@a.test' }));
      const ids = await makeLeads(2);
      const { batch } = await createDistribution(await ctxFor(owner.id), { selection: { mode: 'ids', ids }, strategy: 'EQUAL', targets: [{ organizationId: a.id }], respectQuotas: true, includeInvalid: false, idempotencyKey: `em-${a.id}`, confirmLarge: true });
      await executeBatch(batch.id);
      const cls = await withTenant(a.id, (tx) => tx.clientLead.findMany({ where: { organizationId: a.id } }));
      await withTenant(a.id, (tx) => tx.consentRecord.create({ data: { organizationId: a.id, clientLeadId: cls[0].id, channel: 'EMAIL', status: 'OPTED_OUT', recordedById: ownerA.id } }));
      const c = await createCampaign(ctxA, { name: 'WS', smtpAccountId: acc.id, subject: 'Hi', preheader: null, design: design() as never, audience: { kind: 'workspace', ids: cls.map((x) => x.id) }, trackOpens: false, confirmLarge: false });
      expect(c.skippedCount).toBe(1);
      await runCampaign(c.id);
      const comms = await withTenant(a.id, (tx) => tx.communicationLog.count({ where: { organizationId: a.id, channel: 'EMAIL', verification: 'PROVIDER_VERIFIED' } }));
      expect(comms).toBe(1);
      // Other tenant cannot see the campaign or the sender.
      const cookieB = await cookieFor(ownerB.id);
      expect((await campaignGET(req('/x', { cookie: cookieB }), params({ id: c.id }))).status).toBe(404);
      expect((await (await smtpListGET(req('/x', { cookie: cookieB }))).json()).accounts).toHaveLength(0);
      // Using another tenant's sender id fails.
      await expect(createCampaign(await ctxFor(ownerB.id), { name: 'x', smtpAccountId: acc.id, subject: 'x', preheader: null, design: design() as never, audience: { kind: 'workspace', ids: [] }, trackOpens: false, confirmLarge: false })).rejects.toThrow(/not found/i);
    } finally {
      delete process.env.SMTP_ALLOW_PRIVATE_HOSTS;
    }
  });
});
