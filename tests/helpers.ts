import { randomUUID } from 'node:crypto';
import { ALL_PERMISSIONS, SYSTEM_ROLES } from '@/lib/permissions';
import { buildContext, type AuthContext } from '@/server/auth/context';
import { hashPassword } from '@/server/auth/password';
import { createSession, SESSION_COOKIE } from '@/server/auth/session';
import { prisma, withPlatform } from '@/server/db';
import { provisionWorkspace } from '@/server/services/organizations';

export const PASSWORD = 'Test-Passw0rd!Strong';
let rolesCache: Record<string, string> | null = null;

export async function ensureRoles() {
  if (rolesCache) return rolesCache;
  for (const [key, def] of Object.entries(ALL_PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, create: { key, description: def.description, scope: def.scope, group: def.group, sensitive: Boolean(def.sensitive) }, update: {} });
  }
  const out: Record<string, string> = {};
  for (const r of SYSTEM_ROLES) {
    let role = await prisma.role.findFirst({ where: { key: r.key, organizationId: null } });
    if (!role) {
      role = await prisma.role.create({ data: { key: r.key, name: r.name, scope: r.scope, rank: r.rank, isPrivileged: Boolean(r.isPrivileged), isSystem: true, permissions: { create: r.permissions.map((permissionKey) => ({ permissionKey })) } } });
    }
    out[r.key] = role.id;
  }
  await prisma.platformSetting.upsert({ where: { key: 'security.policy' }, create: { key: 'security.policy', value: { mfaRequiredForPlatform: false } }, update: { value: { mfaRequiredForPlatform: false } } });
  rolesCache = out;
  return out;
}

let pwHash: string | null = null;
export async function makeUser(roleKey: string, organizationId: string | null, opts: { email?: string } = {}) {
  const roles = await ensureRoles();
  pwHash ??= await hashPassword(PASSWORD);
  const user = await prisma.user.create({
    data: { email: opts.email ?? `${roleKey}-${randomUUID().slice(0, 8)}@t.test`, name: `${roleKey} user`, passwordHash: pwHash, status: 'ACTIVE', isPlatformUser: !organizationId },
  });
  await prisma.membership.create({ data: { userId: user.id, organizationId, roleId: roles[roleKey] } });
  return user;
}

export async function makeOrg(name = `Org ${randomUUID().slice(0, 6)}`, quota: Partial<{ maxActiveLeads: number; dailyAllocationLimit: number; regions: string[]; weight: number }> = {}) {
  return withPlatform(async (tx) => {
    const org = await tx.organization.create({
      data: { name, slug: `org-${randomUUID().slice(0, 8)}`, code: `ORG-${randomUUID().slice(0, 6).toUpperCase()}`, settings: {}, quota: { create: { maxActiveLeads: 1000, dailyAllocationLimit: 1000, ...quota } } },
    });
    await provisionWorkspace(tx, org.id);
    return org;
  });
}

export async function makeLeads(n: number, extra: Partial<{ country: string; industry: string; score: number; campaign: string }> = {}) {
  const ids: string[] = [];
  await withPlatform(async (tx) => {
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      ids.push(id);
      await tx.lead.create({ data: { id, fullName: `Lead ${i}`, email: `lead${i}-${id.slice(0, 6)}@example.test`, emailNormalized: `lead${i}-${id.slice(0, 6)}@example.test`, phone: '+14155550100', phoneNormalized: '+14155550100', ...extra } });
    }
  });
  return ids;
}

export async function ctxFor(userId: string): Promise<AuthContext> {
  const { session } = await createSession(userId, { mfaPending: false });
  const full = await prisma.session.findUniqueOrThrow({ where: { id: session.id }, include: { user: true } });
  return buildContext(userId, { requestId: randomUUID(), ip: '127.0.0.1', userAgent: 'vitest' }, full);
}

/** Creates a real session and returns a cookie header for calling route handlers. */
export async function cookieFor(userId: string) {
  const { token } = await createSession(userId, { mfaPending: false });
  return `${SESSION_COOKIE}=${token}`;
}

export function req(path: string, opts: { method?: string; cookie?: string; body?: unknown; origin?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: 'localhost:3100', ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== null) headers.origin = opts.origin ?? 'http://localhost:3100';
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://localhost:3100${path}`, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

export const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
