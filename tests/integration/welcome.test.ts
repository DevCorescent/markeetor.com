import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { passwordProblems, verifyPassword } from '@/server/auth/password';
import { buildContext } from '@/server/auth/context';
import { withPlatform } from '@/server/db';
import { changePassword, login } from '@/server/services/auth';
import { saveSmtpAccount, runCampaign } from '@/server/services/email';
import { configureImport, confirmImport, createImport, runProcessing, runValidation } from '@/server/services/imports';
import { defaultWelcomeSettings, generateTempPassword, nextTimeOfDay, saveWelcomeSettings, sendWelcomeForImport } from '@/server/services/welcome';
import { PASSWORD, ctxFor, ensureRoles, makeUser } from '../helpers';

const received: { to: string; raw: string }[] = [];
let server: SMTPServer;
let ownerId: string;
const meta = { requestId: 'test', ip: '10.9.0.1', userAgent: 'vitest' };
const importOpts = { dedupeKeys: ['email'] as ('email' | 'phone')[], onDuplicate: 'skip' as const, requireName: true, requireContact: true, requireEmail: false, requirePhone: false, defaultCountry: 'US', autoConfirm: false };

/** Decodes the MIME body enough to read the rendered HTML (quoted-printable or base64 parts). */
function body(raw: string) {
  const qp = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  const b64 = [...raw.matchAll(/Content-Transfer-Encoding: base64\r?\n(?:.+\r?\n)*\r?\n([A-Za-z0-9+/=\r\n]+)/g)].map((m) => Buffer.from(m[1].replace(/\s/g, ''), 'base64').toString('utf8'));
  return [qp, ...b64].join('\n');
}
const tempPasswordIn = (raw: string) => /<code>([^<]+)<\/code>/.exec(body(raw))?.[1] ?? null;

async function importLeads(csv: string, source: string) {
  const ctx = await ctxFor(ownerId);
  const { import: imp } = await createImport(ctx, { name: 'welcome.csv', size: csv.length, buffer: Buffer.from(csv) });
  await configureImport(ctx, imp.id, { mapping: { Name: 'fullName', Email: 'email', Company: 'company' }, options: importOpts, tags: [], source });
  await runValidation(imp.id);
  await confirmImport(ctx, imp.id);
  await runProcessing(imp.id);
  return imp.id;
}
const welcomeCampaign = (importId: string) => withPlatform((tx) => tx.emailCampaign.findFirst({ where: { audience: { path: ['importId'], equals: importId } } }));

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
  const acc = await saveSmtpAccount(ctx, null, { label: 'Welcome', host: '127.0.0.1', port, secure: false, username: 'u', password: 'p', fromName: 'markeetor', fromEmail: 'hello@platform.test', replyTo: null, dailyLimit: 1000, perMinuteLimit: 600, isDefault: true });
  await saveWelcomeSettings(ctx, { ...defaultWelcomeSettings(), enabled: true, smtpAccountId: acc.id, sources: ['Expo'] });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('welcome emails', () => {
  it('generates temporary passwords that satisfy the password policy', () => {
    for (let i = 0; i < 50; i++) expect(passwordProblems(generateTempPassword(), 12)).toEqual([]);
  });

  it('schedules daily sends for the next matching wall-clock time', () => {
    const now = new Date('2026-10-07T09:30:00Z');
    expect(nextTimeOfDay('10:00', 'UTC', now).toISOString()).toBe('2026-10-07T10:00:00.000Z');
    expect(nextTimeOfDay('09:00', 'UTC', now).toISOString()).toBe('2026-10-08T09:00:00.000Z');
    expect(nextTimeOfDay('10:00', 'Asia/Kolkata', now).toISOString()).toBe('2026-10-08T04:30:00.000Z');
  });

  it('creates a workspace and account per new lead, emails a temporary password and forces a change', async () => {
    const staff = await makeUser('analytics_admin', null, { email: `staff-${Date.now()}@welcome.test` });
    const stamp = Date.now();
    const csv = ['Name,Email,Company', `Wendy Lead,wendy-${stamp}@welcome.test,Wendy Co`, `Staff Person,${staff.email},Staff Co`].join('\n');
    received.length = 0;
    const importId = await importLeads(csv, 'Expo');
    const c = await welcomeCampaign(importId);
    expect(c?.status).toBe('QUEUED');
    await runCampaign(c!.id);

    const email = `wendy-${stamp}@welcome.test`;
    expect(received.map((r) => r.to)).toEqual([email]);
    const temp = tempPasswordIn(received[0].raw);
    expect(temp).toBeTruthy();
    expect(body(received[0].raw)).toContain(email);

    const user = await withPlatform((tx) => tx.user.findUniqueOrThrow({ where: { email }, include: { membership: { include: { role: true, organization: true } } } }));
    expect(user.mustChangePassword).toBe(true);
    expect(user.membership?.role.key).toBe('client_owner');
    expect(user.membership?.organization?.name).toBe('Wendy Co');
    expect(await verifyPassword(user.passwordHash, temp!)).toBe(true);

    // The password is never persisted in the message log.
    const msgs = await withPlatform((tx) => tx.emailMessage.findMany({ where: { campaignId: c!.id } }));
    expect(JSON.stringify(msgs)).not.toContain(temp!);
    expect(msgs.find((m) => m.toEmail === staff.email)?.error).toBe('Already has an account');

    // First sign-in is restricted to choosing a new password.
    await login({ email, password: temp! }, meta);
    const session = await withPlatform((tx) => tx.session.findFirstOrThrow({ where: { userId: user.id } }));
    const ctx = await buildContext(user.id, meta, { ...session, mfaPending: false } as never);
    expect(ctx.restriction).toBe('PASSWORD_CHANGE_REQUIRED');
    await expect(changePassword(ctx, temp!, temp!)).rejects.toThrow(/different/);
    await changePassword(ctx, temp!, PASSWORD);
    const after = await withPlatform((tx) => tx.user.findUniqueOrThrow({ where: { id: user.id } }));
    expect([after.mustChangePassword, after.tempPasswordExpiresAt]).toEqual([false, null]);
    expect((await buildContext(user.id, meta, { ...session, mfaPending: false } as never)).restriction).toBeNull();

    // An existing account is never touched.
    const s = await withPlatform((tx) => tx.user.findUniqueOrThrow({ where: { id: staff.id } }));
    expect(s.mustChangePassword).toBe(false);
    expect(await verifyPassword(s.passwordHash, PASSWORD)).toBe(true);
  });

  it('rejects expired temporary passwords', async () => {
    const stamp = Date.now();
    received.length = 0;
    const importId = await importLeads(['Name,Email,Company', `Exp Ired,exp-${stamp}@welcome.test,Expired Co`].join('\n'), 'Expo');
    await runCampaign((await welcomeCampaign(importId))!.id);
    const temp = tempPasswordIn(received[0].raw)!;
    await withPlatform((tx) => tx.user.update({ where: { email: `exp-${stamp}@welcome.test` }, data: { tempPasswordExpiresAt: new Date(Date.now() - 1000) } }));
    await expect(login({ email: `exp-${stamp}@welcome.test`, password: temp }, meta)).rejects.toThrow(/expired/);
  });

  it('only welcomes the selected sources, never twice, and can be sent manually', async () => {
    const stamp = Date.now();
    const importId = await importLeads(['Name,Email,Company', `Other Src,other-${stamp}@welcome.test,Other`].join('\n'), 'Web');
    expect(await welcomeCampaign(importId)).toBeNull();
    const ctx = await ctxFor(ownerId);
    await expect(sendWelcomeForImport(ctx, importId)).rejects.toThrow(/selected sources/);
    await saveWelcomeSettings(ctx, { ...defaultWelcomeSettings(), enabled: true, sources: [] });
    const res = await sendWelcomeForImport(ctx, importId);
    expect(res.campaignId).toBeTruthy();
    await expect(sendWelcomeForImport(ctx, importId)).rejects.toThrow(/already/);
  });

  it('refuses a welcome email without login details or with the password in the subject', async () => {
    const ctx = await ctxFor(ownerId);
    const base = defaultWelcomeSettings();
    await expect(saveWelcomeSettings(ctx, { ...base, enabled: true, design: { ...base.design, blocks: base.design.blocks.filter((b) => b.id !== 'w3') } })).rejects.toThrow(/temporaryPassword/);
    await expect(saveWelcomeSettings(ctx, { ...base, subject: 'Your password: {{temporaryPassword}}' })).rejects.toThrow();
  });
});
