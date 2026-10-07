import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { PRESETS } from '@/lib/email/presets';
import { checkContent } from '@/lib/email/spam-check';
import type { EmailDesign } from '@/lib/email/types';
import { withPlatform } from '@/server/db';
import { analyzeSender, generateDkim, publicAppUrl, setDkim, type Resolver } from '@/server/services/deliverability';
import { createCampaign, designSchema, runCampaign, saveSmtpAccount, sendTest } from '@/server/services/email';
import { ctxFor, ensureRoles, makeLeads, makeUser } from '../helpers';

const received: { raw: string; helo: string }[] = [];
let server: SMTPServer;
let port = 0;
let ownerId: string;

const fakeDns = (txt: Record<string, string[]>, mx: string[] = ['mx.acme.test']): Resolver => ({
  txt: async (name) => { if (!txt[name]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); return txt[name].map((t) => [t]); },
  mx: async () => mx.map((exchange, priority) => ({ exchange, priority })),
  cname: async () => { throw new Error('ENODATA'); },
});
const base = { host: 'smtp.gmail.com', username: 'hello@acme.test', fromEmail: 'hello@acme.test', status: 'VERIFIED', dailyLimit: 500, dkimEnabled: false, dkimSelector: null, dkimPublicKey: null };

beforeAll(async () => {
  await ensureRoles();
  ownerId = (await makeUser('platform_owner', null)).id;
  server = new SMTPServer({
    authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], logger: false,
    onAuth: (_a, _s, cb) => cb(null, { user: 'test' }),
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c.toString()));
      stream.on('end', () => { received.push({ raw, helo: session.hostNameAppearsAs }); cb(); });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('domain checks', () => {
  it('fails a domain with no SPF, DKIM or DMARC and says exactly what to add', async () => {
    const r = await analyzeSender(base, fakeDns({}));
    const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
    expect(by.spf.status).toBe('fail');
    expect(by.spf.fix?.value).toBe('v=spf1 include:_spf.google.com ~all');
    expect(by.dkim.status).toBe('fail');
    expect(by.dmarc.fix?.host).toBe('_dmarc.acme.test');
    expect(r.score).toBeLessThan(60);
  });

  it('passes a fully authenticated domain', async () => {
    const r = await analyzeSender(base, fakeDns({
      'acme.test': ['v=spf1 include:_spf.google.com ~all'],
      'google._domainkey.acme.test': ['v=DKIM1; k=rsa; p=MIIBIjAN'],
      '_dmarc.acme.test': ['v=DMARC1; p=quarantine'],
    }));
    expect(r.checks.filter((c) => ['spf', 'dkim', 'dmarc', 'mx', 'domain'].includes(c.key)).every((c) => c.status === 'pass')).toBe(true);
  });

  it('rejects sending as a free-mail address through another server', async () => {
    const r = await analyzeSender({ ...base, host: 'smtp.sendgrid.net', fromEmail: 'me@gmail.com' }, fakeDns({}));
    expect(r.checks.find((c) => c.key === 'domain')?.status).toBe('fail');
  });

  it('only treats public https URLs as safe to put in emails', () => {
    expect(publicAppUrl('https://app.markeetor.com')).toBe(true);
    expect(publicAppUrl('http://localhost:3100')).toBe(false);
    expect(publicAppUrl('https://192.168.1.4')).toBe(false);
    expect(publicAppUrl('http://markeetor.com')).toBe(false);
  });
});

describe('content checks', () => {
  it('flags spammy content and passes a clean email', () => {
    const spammy = checkContent({ subject: 'FREE MONEY!!! ACT NOW', preheader: '', design: { version: 1, settings: PRESETS[0].design().settings, blocks: [
      { id: 'a', type: 'text', align: 'left', html: '<p>Click here for a guaranteed winner prize. <a href="https://bit.ly/x">www.bank.com</a></p>' },
    ] } as EmailDesign });
    expect(spammy.score).toBeLessThan(40);
    expect(spammy.issues.map((i) => i.message).join(' ')).toMatch(/ALL CAPS|shorteners|phishing|unsubscribe/);
    const clean = checkContent({ subject: 'Your March report for Acme', preheader: 'Highlights from the month', design: { version: 1, settings: PRESETS[0].design().settings, blocks: [
      { id: 'a', type: 'text', align: 'left', html: `<p>Hi {{firstName}}, ${'here is a short summary of how your account performed this month and what we plan next. '.repeat(4)}</p>` },
      { id: 'b', type: 'button', label: 'Open the report', url: 'https://app.acme.test/reports/3', align: 'left', variant: 'solid', fullWidth: false },
      { id: 'c', type: 'footer', html: '<p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>' },
    ] } as EmailDesign });
    expect(clean.issues.filter((i) => i.level !== 'info')).toEqual([]);
  });
});

describe('sending', () => {
  it('greets with the sending domain, signs with DKIM and adds one-click unsubscribe', async () => {
    const ctx = await ctxFor(ownerId);
    const acc = await saveSmtpAccount(ctx, null, { label: 'Signed', host: '127.0.0.1', port, secure: false, username: 'u', password: 'p', fromName: 'Acme', fromEmail: 'hello@acme.test', replyTo: null, dailyLimit: 1000, perMinuteLimit: 600, isDefault: false });
    const rec = await generateDkim(ctx, acc.id);
    expect(rec?.host).toMatch(/^mk\d{8}\._domainkey\.acme\.test$/);
    await expect(setDkim(ctx, acc.id, true, fakeDns({}))).rejects.toThrow(/not visible/);
    await setDkim(ctx, acc.id, true, fakeDns({ [rec!.host]: [rec!.value] }));

    received.length = 0;
    const design = designSchema.parse(PRESETS[0].design()) as EmailDesign;
    await sendTest(ctx, { smtpAccountId: acc.id, to: 'someone@example.com', subject: 'Hello', design });
    expect(received[0].helo).toBe('acme.test');
    expect(received[0].raw).toMatch(/DKIM-Signature:[\s\S]*d=acme\.test/);
    expect(received[0].raw).toContain(`s=${rec!.host.split('.')[0]}`);

    const [leadId] = await makeLeads(1);
    received.length = 0;
    const c = await createCampaign(ctx, { name: 'Bulk', smtpAccountId: acc.id, subject: 'Hi', preheader: null, design: design as never, audience: { kind: 'platform', selection: { mode: 'ids', ids: [leadId] } }, trackOpens: true, confirmLarge: false });
    await runCampaign(c.id);
    const raw = received[0].raw.replace(/\r?\n\s+/g, ' ');
    expect(raw).toMatch(/List-Unsubscribe: <http:\/\/localhost:3100\/api\/v1\/email\/unsubscribe\/[A-Za-z0-9_-]+>/);
    expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(raw).toMatch(/Feedback-ID: \S+:markeetor/);
    const stored = await withPlatform((tx) => tx.smtpAccount.findUniqueOrThrow({ where: { id: acc.id } }));
    expect(stored.dkimPrivateKeyEnc).not.toContain('PRIVATE KEY');
  });
});
