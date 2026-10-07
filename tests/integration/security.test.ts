import { beforeAll, describe, expect, it } from 'vitest';
import { GET as crmLeadGET, PATCH as crmLeadPATCH } from '@/app/api/v1/crm/leads/[id]/route';
import { POST as crmRevealPOST } from '@/app/api/v1/crm/leads/[id]/reveal/route';
import { GET as crmLeadsGET } from '@/app/api/v1/crm/leads/route';
import { POST as crmBulkPOST } from '@/app/api/v1/crm/leads/bulk/route';
import { POST as crmInvitePOST } from '@/app/api/v1/crm/users/invite/route';
import { GET as attachmentGET } from '@/app/api/v1/crm/attachments/[id]/route';
import { GET as leadsGET } from '@/app/api/v1/leads/route';
import { POST as exportPOST } from '@/app/api/v1/leads/export/route';
import { GET as overviewGET } from '@/app/api/v1/admin/overview/route';
import { PUT as overridePUT } from '@/app/api/v1/users/[id]/overrides/route';
import { POST as rolePOST } from '@/app/api/v1/users/[id]/role/route';
import { POST as stepUpPOST } from '@/app/api/v1/auth/step-up/route';
import { prisma, withPlatform, withTenant } from '@/server/db';
import { createDistribution, executeBatch } from '@/server/services/distribution';
import { uploadAttachment } from '@/server/services/attachments';
import { cookieFor, ctxFor, ensureRoles, makeLeads, makeOrg, makeUser, params, PASSWORD, req } from '../helpers';

let orgA: { id: string }, orgB: { id: string };
let ownerA: { id: string }, analystA: { id: string }, execA: { id: string }, adminA: { id: string }, managerB: { id: string }, platform: { id: string }, opsUser: { id: string };
let leadA: string, leadB: string;

beforeAll(async () => {
  await ensureRoles();
  orgA = await makeOrg('Alpha');
  orgB = await makeOrg('Beta');
  ownerA = await makeUser('client_owner', orgA.id);
  adminA = await makeUser('client_admin', orgA.id);
  analystA = await makeUser('read_only_analyst', orgA.id);
  execA = await makeUser('sales_executive', orgA.id);
  managerB = await makeUser('sales_manager', orgB.id);
  platform = await makeUser('platform_owner', null);
  opsUser = await makeUser('lead_ops_manager', null);
  const ids = await makeLeads(4);
  const pctx = await ctxFor(platform.id);
  const r1 = await createDistribution(pctx, { selection: { mode: 'ids', ids: ids.slice(0, 2) }, strategy: 'EQUAL', targets: [{ organizationId: orgA.id }], respectQuotas: true, includeInvalid: false, idempotencyKey: 'sec-a-0001', confirmLarge: true });
  await executeBatch(r1.batch.id);
  const r2 = await createDistribution(pctx, { selection: { mode: 'ids', ids: ids.slice(2, 4) }, strategy: 'EQUAL', targets: [{ organizationId: orgB.id }], respectQuotas: true, includeInvalid: false, idempotencyKey: 'sec-b-0001', confirmLarge: true });
  await executeBatch(r2.batch.id);
  leadA = (await withTenant(orgA.id, (tx) => tx.clientLead.findFirstOrThrow({ where: { organizationId: orgA.id } }))).id;
  leadB = (await withTenant(orgB.id, (tx) => tx.clientLead.findFirstOrThrow({ where: { organizationId: orgB.id } }))).id;
});

describe('authentication', () => {
  it('rejects unauthenticated API calls', async () => {
    const res = await crmLeadsGET(req('/api/v1/crm/leads'));
    expect(res.status).toBe(401);
  });
  it('rejects a revoked session immediately', async () => {
    const cookie = await cookieFor(managerB.id);
    expect((await crmLeadsGET(req('/api/v1/crm/leads', { cookie }))).status).toBe(200);
    await prisma.session.updateMany({ where: { userId: managerB.id }, data: { revokedAt: new Date() } });
    expect((await crmLeadsGET(req('/api/v1/crm/leads', { cookie }))).status).toBe(401);
  });
  it('rejects sessions of suspended users', async () => {
    const u = await makeUser('sales_executive', orgB.id);
    const cookie = await cookieFor(u.id);
    await prisma.user.update({ where: { id: u.id }, data: { status: 'SUSPENDED' } });
    expect((await crmLeadsGET(req('/api/v1/crm/leads', { cookie }))).status).toBe(401);
  });
  it('blocks access when the workspace is suspended', async () => {
    const org = await makeOrg('Gamma');
    const u = await makeUser('client_owner', org.id);
    const cookie = await cookieFor(u.id);
    await prisma.organization.update({ where: { id: org.id }, data: { status: 'SUSPENDED' } });
    expect((await crmLeadsGET(req('/api/v1/crm/leads', { cookie }))).status).toBe(403);
  });
  it('rejects forged / malformed tokens', async () => {
    expect((await crmLeadsGET(req('/api/v1/crm/leads', { cookie: 'lc_session=' + 'A'.repeat(43) }))).status).toBe(401);
  });
});

describe('tenant isolation', () => {
  it('returns 404 (not 403) for another tenant’s lead — no IDOR, no enumeration', async () => {
    const cookie = await cookieFor(ownerA.id);
    const res = await crmLeadGET(req(`/api/v1/crm/leads/${leadB}`, { cookie }), params({ id: leadB }));
    expect(res.status).toBe(404);
    const own = await crmLeadGET(req(`/api/v1/crm/leads/${leadA}`, { cookie }), params({ id: leadA }));
    expect(own.status).toBe(200);
  });
  it('cannot reveal or modify another tenant’s lead', async () => {
    const cookie = await cookieFor(ownerA.id);
    expect((await crmRevealPOST(req(`/x`, { cookie, body: { field: 'phone' } }), params({ id: leadB }))).status).toBe(404);
    expect((await crmLeadPATCH(req(`/x`, { cookie, method: 'PATCH', body: { fullName: 'pwned' } }), params({ id: leadB }))).status).toBe(404);
    const b = await withTenant(orgB.id, (tx) => tx.clientLead.findUniqueOrThrow({ where: { id: leadB } }));
    expect(b.fullName).not.toBe('pwned');
  });
  it('lists only the caller’s tenant even with crafted filters', async () => {
    const cookie = await cookieFor(ownerA.id);
    const filter = encodeURIComponent(JSON.stringify({ conditions: [{ field: 'organizationId', op: 'in', value: [orgB.id] }] }));
    const body = await (await crmLeadsGET(req(`/api/v1/crm/leads?filter=${filter}`, { cookie }))).json();
    expect(body.rows.every((r: { id: string }) => r.id !== leadB)).toBe(true);
    expect(body.total).toBe(2);
  });
  it('row-level security hides other tenants even from raw queries in a tenant transaction', async () => {
    const rows = await withTenant(orgA.id, (tx) => tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM client_leads WHERE "organizationId" = ${orgB.id}`);
    expect(Number(rows[0].n)).toBe(0);
    const master = await withTenant(orgA.id, (tx) => tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM leads`);
    expect(Number(master[0].n)).toBe(0);
  });
  it('RLS rejects writes tagged with another tenant', async () => {
    await expect(withTenant(orgA.id, (tx) => tx.note.create({ data: { organizationId: orgB.id, clientLeadId: leadB, authorId: ownerA.id, body: 'x' } }))).rejects.toThrow();
  });
  it('the platform-only master table is invisible outside platform transactions', async () => {
    expect(await prisma.lead.count()).toBe(0);
    expect(await withPlatform((tx) => tx.lead.count())).toBeGreaterThan(0);
  });
  it('bulk assignment cannot target a user from another tenant', async () => {
    const cookie = await cookieFor(ownerA.id);
    const res = await crmBulkPOST(req('/x', { cookie, body: { action: 'assign', ids: [leadA], ownerId: managerB.id } }));
    expect(res.status).toBe(422);
  });
  it('bulk actions silently skip ids from other tenants', async () => {
    const cookie = await cookieFor(ownerA.id);
    const res = await crmBulkPOST(req('/x', { cookie, body: { action: 'archive', ids: [leadB] } }));
    expect((await res.json()).updated).toBe(0);
  });
});

describe('authorization', () => {
  it('denies client users every platform endpoint', async () => {
    const cookie = await cookieFor(ownerA.id);
    expect((await leadsGET(req('/api/v1/leads', { cookie }))).status).toBe(403);
    expect((await overviewGET(req('/api/v1/admin/overview', { cookie }))).status).toBe(403);
  });
  it('has no export path for clients, and audits the denial', async () => {
    const cookie = await cookieFor(ownerA.id);
    const res = await exportPOST(req('/x', { cookie, body: { filter: { conditions: [] }, reason: 'take everything' } }));
    expect(res.status).toBe(403);
    const denied = await withPlatform((tx) => tx.auditEvent.findFirst({ where: { actorId: ownerA.id, action: 'access.denied' } }));
    expect(denied).not.toBeNull();
  });
  it('platform export requires the export permission and a recent step-up', async () => {
    const ops = await cookieFor(opsUser.id);
    expect((await exportPOST(req('/x', { cookie: ops, body: { filter: { conditions: [] }, reason: 'reconcile' } }))).status).toBe(403);
    const own = await cookieFor(platform.id);
    const res = await exportPOST(req('/x', { cookie: own, body: { filter: { conditions: [] }, reason: 'reconcile' } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('STEP_UP_REQUIRED');
    expect((await stepUpPOST(req('/x', { cookie: own, body: { password: PASSWORD } }))).status).toBe(200);
    const ok = await exportPOST(req('/x', { cookie: own, body: { filter: { conditions: [] }, reason: 'reconcile' } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/csv');
  });
  it('read-only analysts see masked data and cannot reveal', async () => {
    const cookie = await cookieFor(analystA.id);
    const detail = await (await crmLeadGET(req('/x', { cookie }), params({ id: leadA }))).json();
    expect(detail.lead.email).toContain('•');
    expect(detail.lead.phone).toContain('•');
    expect((await crmRevealPOST(req('/x', { cookie, body: { field: 'phone' } }), params({ id: leadA }))).status).toBe(403);
  });
  it('reveals are audited and recorded as activity', async () => {
    const cookie = await cookieFor(ownerA.id);
    const res = await crmRevealPOST(req('/x', { cookie, body: { field: 'phone' } }), params({ id: leadA }));
    expect(res.status).toBe(200);
    expect((await res.json()).value).toBe('+14155550100');
    const ev = await withPlatform((tx) => tx.auditEvent.findFirst({ where: { action: 'crm.lead.field.revealed', targetId: leadA } }));
    expect(ev?.metadata).toMatchObject({ field: 'phone' });
  });
  it('sales executives only see leads assigned to them', async () => {
    const cookie = await cookieFor(execA.id);
    expect((await (await crmLeadsGET(req('/x', { cookie }))).json()).total).toBe(0);
    expect((await crmLeadGET(req('/x', { cookie }), params({ id: leadA }))).status).toBe(404);
  });
  it('clients cannot change source attribution', async () => {
    const cookie = await cookieFor(ownerA.id);
    expect((await crmLeadPATCH(req('/x', { cookie, method: 'PATCH', body: { source: 'Forged' } }), params({ id: leadA }))).status).toBe(422);
    expect((await crmLeadPATCH(req('/x', { cookie, method: 'PATCH', body: { campaign: 'Forged' } }), params({ id: leadA }))).status).toBe(422);
  });
  it('blocks cross-origin mutations (CSRF)', async () => {
    const cookie = await cookieFor(ownerA.id);
    expect((await crmBulkPOST(req('/x', { cookie, origin: 'https://evil.example', body: { action: 'archive', ids: [leadA] } }))).status).toBe(403);
    expect((await crmBulkPOST(req('/x', { cookie, origin: null, body: { action: 'archive', ids: [leadA] } }))).status).toBe(403);
  });
});

describe('privilege escalation', () => {
  it('a client admin cannot invite a more privileged role', async () => {
    const roles = await ensureRoles();
    const cookie = await cookieFor(adminA.id);
    const res = await crmInvitePOST(req('/x', { cookie, body: { email: 'boss@t.test', name: 'Boss', roleId: roles.client_owner } }));
    expect(res.status).toBe(403);
  });
  it('a client cannot assign a platform role', async () => {
    const roles = await ensureRoles();
    const cookie = await cookieFor(ownerA.id);
    const res = await crmInvitePOST(req('/x', { cookie, body: { email: 'x@t.test', name: 'X', roleId: roles.platform_owner } }));
    expect(res.status).toBe(422);
  });
  it('permission overrides cannot grant permissions the granter lacks, nor cross scope', async () => {
    const sec = await makeUser('security_admin', null);
    const target = await makeUser('analytics_admin', null);
    const cookie = await cookieFor(sec.id);
    // security_admin lacks roles.manage entirely
    expect((await overridePUT(req('/x', { cookie, method: 'PUT', body: { permissionKey: 'leads.export', effect: 'GRANT', reason: 'need it' } }), params({ id: target.id }))).status).toBe(403);
    const ownerCookie = await cookieFor(platform.id);
    await stepUpPOST(req('/x', { cookie: ownerCookie, body: { password: PASSWORD } }));
    const cross = await overridePUT(req('/x', { cookie: ownerCookie, method: 'PUT', body: { permissionKey: 'crm.leads.reveal', effect: 'GRANT', reason: 'x' } }), params({ id: target.id }));
    expect(cross.status).toBe(422);
  });
  it('granting a privileged role creates an approval instead of applying it', async () => {
    const roles = await ensureRoles();
    const admin = await makeUser('super_admin', null);
    const target = await makeUser('analytics_admin', null);
    const cookie = await cookieFor(admin.id);
    await stepUpPOST(req('/x', { cookie, body: { password: PASSWORD } }));
    const res = await rolePOST(req('/x', { cookie, body: { roleId: roles.super_admin, reason: 'promotion' } }), params({ id: target.id }));
    const body = await res.json();
    expect(body.pendingApproval).toBeTruthy();
    const m = await prisma.membership.findUniqueOrThrow({ where: { userId: target.id } });
    expect(m.roleId).toBe(roles.analytics_admin);
  });
  it('users cannot change their own role', async () => {
    const roles = await ensureRoles();
    const cookie = await cookieFor(platform.id);
    await stepUpPOST(req('/x', { cookie, body: { password: PASSWORD } }));
    expect((await rolePOST(req('/x', { cookie, body: { roleId: roles.analytics_admin, reason: 'self demotion' } }), params({ id: platform.id }))).status).toBe(403);
  });
});

describe('attachments', () => {
  it('rejects disguised executables and serves files inline only to the owning tenant', async () => {
    const ctx = await ctxFor(ownerA.id);
    await expect(uploadAttachment(ctx, leadA, { name: 'x.pdf', buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]) })).rejects.toThrow();
    const a = await uploadAttachment(ctx, leadA, { name: 'notes.txt', buffer: Buffer.from('hello world') });
    const own = await attachmentGET(req('/x', { cookie: await cookieFor(ownerA.id) }), params({ id: a.id }));
    expect(own.status).toBe(200);
    expect(own.headers.get('content-disposition')).toMatch(/^inline/);
    expect(own.headers.get('content-security-policy')).toContain('sandbox');
    expect((await attachmentGET(req('/x', { cookie: await cookieFor(managerB.id) }), params({ id: a.id }))).status).toBe(404);
    expect((await attachmentGET(req('/x', { cookie: await cookieFor(analystA.id) }), params({ id: a.id }))).status).toBe(403);
  });
});
