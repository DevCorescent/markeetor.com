import { beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { POST as loginPOST } from '@/app/api/v1/auth/login/route';
import { POST as mfaVerifyPOST } from '@/app/api/v1/auth/mfa/verify/route';
import { GET as crmLeadsGET } from '@/app/api/v1/crm/leads/route';
import { encryptSecret } from '@/server/auth/mfa';
import { prisma } from '@/server/db';
import { ensureRoles, makeOrg, makeUser, PASSWORD, req } from '../helpers';

const loginReq = (email: string, password: string, ip = '10.0.0.1') => req('/api/v1/auth/login', { body: { email, password }, headers: { 'x-forwarded-for': ip } });
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0];

beforeAll(async () => { await ensureRoles(); });

describe('login', () => {
  it('uses a generic message for wrong password and unknown email', async () => {
    const org = await makeOrg();
    const u = await makeUser('client_owner', org.id);
    const a = await (await loginPOST(loginReq(u.email, 'wrong-password', '10.0.0.2'))).json();
    const b = await (await loginPOST(loginReq('nobody@t.test', 'wrong-password', '10.0.0.2'))).json();
    expect(a.error.message).toBe(b.error.message);
  });

  it('locks the account after repeated failures and raises an alert', async () => {
    const org = await makeOrg();
    const u = await makeUser('sales_manager', org.id);
    for (let i = 0; i < 5; i++) await loginPOST(loginReq(u.email, `bad-${i}`, `10.1.0.${i}`));
    const res = await loginPOST(loginReq(u.email, PASSWORD, '10.1.0.9'));
    expect(res.status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).lockedUntil).not.toBeNull();
    expect(await prisma.securityAlert.count({ where: { type: 'ACCOUNT_LOCKED', userId: u.id } })).toBe(1);
  });

  it('issues an HttpOnly SameSite session cookie and records login history', async () => {
    const org = await makeOrg();
    const u = await makeUser('client_owner', org.id);
    const res = await loginPOST(loginReq(u.email, PASSWORD, '10.2.0.1'));
    expect(res.status).toBe(200);
    const sc = res.headers.get('set-cookie')!;
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Lax/);
    expect(await prisma.loginEvent.count({ where: { userId: u.id, success: true } })).toBe(1);
    expect((await crmLeadsGET(req('/x', { cookie: cookieOf(res) }))).status).toBe(200);
  });

  it('requires the second factor before granting access, and rotates the session token', async () => {
    const org = await makeOrg();
    const u = await makeUser('client_owner', org.id);
    const secret = authenticator.generateSecret();
    await prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: true, mfaSecretEnc: encryptSecret(secret) } });
    const res = await loginPOST(loginReq(u.email, PASSWORD, '10.3.0.1'));
    expect((await res.json()).mfaRequired).toBe(true);
    const pending = cookieOf(res);
    const blocked = await crmLeadsGET(req('/x', { cookie: pending }));
    expect(blocked.status).toBe(401);
    expect((await blocked.json()).error.code).toBe('MFA_REQUIRED');
    expect((await mfaVerifyPOST(req('/x', { cookie: pending, body: { code: '000000' } }))).status).toBe(401);
    const ok = await mfaVerifyPOST(req('/x', { cookie: pending, body: { code: authenticator.generate(secret) } }));
    expect(ok.status).toBe(200);
    const rotated = cookieOf(ok);
    expect(rotated).not.toBe(pending);
    expect((await crmLeadsGET(req('/x', { cookie: pending }))).status).toBe(401);
    expect((await crmLeadsGET(req('/x', { cookie: rotated }))).status).toBe(200);
  });

  it('enforces workspace MFA requirements before any data access', async () => {
    const org = await makeOrg();
    await prisma.organization.update({ where: { id: org.id }, data: { settings: { security: { mfaRequired: true } } } });
    const u = await makeUser('client_owner', org.id);
    const res = await loginPOST(loginReq(u.email, PASSWORD, '10.4.0.1'));
    const r = await crmLeadsGET(req('/x', { cookie: cookieOf(res) }));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('MFA_ENROLLMENT_REQUIRED');
  });

  it('honours workspace IP allowlists', async () => {
    const org = await makeOrg();
    await prisma.organization.update({ where: { id: org.id }, data: { settings: { security: { ipAllowlist: ['192.168.1.*'] } } } });
    const u = await makeUser('client_owner', org.id);
    expect((await loginPOST(loginReq(u.email, PASSWORD, '10.5.0.1'))).status).toBe(403);
    expect((await loginPOST(loginReq(u.email, PASSWORD, '192.168.1.20'))).status).toBe(200);
  });
});
