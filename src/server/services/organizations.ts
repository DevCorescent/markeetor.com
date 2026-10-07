import type { OrgStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { audit, diff } from '../audit';
import type { AuthContext } from '../auth/context';
import { revokeAllSessions } from '../auth/session';
import { shortCode } from '../crypto';
import { withPlatform, type Tx } from '../db';
import { AppError, notFound } from '../errors';
import { createInvitation } from './users';

export const DEFAULT_FEATURES = {
  pipeline: true,
  tasks: true,
  communication: true,
  analytics: true,
  attachments: true,
  teams: true,
  email: true,
  marketplace: true,
  funnels: true,
  automation: false,
};
export type OrgFeatures = typeof DEFAULT_FEATURES;

export const DEFAULT_ORG_SECURITY = {
  mfaRequired: false,
  sessionIdleMinutes: 30,
  ipAllowlist: [] as string[],
  revealRequiresReason: false,
  watermark: true,
};

export type OrgSettings = {
  features: OrgFeatures;
  security: typeof DEFAULT_ORG_SECURITY;
  branding: { primaryLabel?: string };
  workflows: { staleLeadDays: number; firstContactSlaHours: number };
};

export function orgSettings(raw: unknown): OrgSettings {
  const s = (raw ?? {}) as Partial<OrgSettings>;
  return {
    features: { ...DEFAULT_FEATURES, ...(s.features ?? {}) },
    security: { ...DEFAULT_ORG_SECURITY, ...(s.security ?? {}) },
    branding: { ...(s.branding ?? {}) },
    workflows: { staleLeadDays: 7, firstContactSlaHours: 24, ...(s.workflows ?? {}) },
  };
}

export const DEFAULT_STAGES: { name: string; category: 'OPEN' | 'WON' | 'LOST'; probability: number; stagnantAfterDays: number | null }[] = [
  { name: 'New', category: 'OPEN', probability: 5, stagnantAfterDays: 3 },
  { name: 'Contacted', category: 'OPEN', probability: 15, stagnantAfterDays: 7 },
  { name: 'Qualified', category: 'OPEN', probability: 35, stagnantAfterDays: 10 },
  { name: 'Proposal', category: 'OPEN', probability: 55, stagnantAfterDays: 14 },
  { name: 'Negotiation', category: 'OPEN', probability: 75, stagnantAfterDays: 14 },
  { name: 'Won', category: 'WON', probability: 100, stagnantAfterDays: null },
  { name: 'Lost', category: 'LOST', probability: 0, stagnantAfterDays: null },
];

export async function provisionWorkspace(tx: Tx, organizationId: string) {
  const pipeline = await tx.pipeline.create({ data: { organizationId, name: 'Sales pipeline', isDefault: true } });
  await tx.pipelineStage.createMany({
    data: DEFAULT_STAGES.map((s, i) => ({ organizationId, pipelineId: pipeline.id, position: i, ...s })),
  });
  return pipeline;
}

const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'org';

export const orgInput = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(200).optional().nullable(),
  gstin: z.string().trim().toUpperCase().max(15).regex(/^([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])?$/, 'Enter a valid 15-character GSTIN').optional().nullable(),
  billingState: z.string().trim().max(60).optional().nullable(),
  industry: z.string().trim().max(80).optional().nullable(),
  website: z.string().trim().url().max(300).optional().nullable().or(z.literal('').transform(() => null)),
  contactEmail: z.string().trim().email().max(254).optional().nullable().or(z.literal('').transform(() => null)),
  contactPhone: z.string().trim().max(40).optional().nullable(),
  address: z.string().trim().max(400).optional().nullable(),
  timezone: z.string().trim().max(60).optional(),
});

export const quotaInput = z.object({
  maxUsers: z.number().int().min(1).max(10_000),
  maxActiveLeads: z.number().int().min(0).max(10_000_000),
  dailyAllocationLimit: z.number().int().min(0).max(1_000_000),
  monthlyAllocationLimit: z.number().int().min(0).max(10_000_000),
  weight: z.number().int().min(0).max(1000),
  acceptsAutoDistribution: z.boolean(),
  autoPauseAtCapacity: z.boolean(),
  capacityPaused: z.boolean(),
  regions: z.array(z.string().trim().min(1).max(80)).max(200),
  industries: z.array(z.string().trim().min(1).max(80)).max(200),
  campaigns: z.array(z.string().trim().min(1).max(120)).max(200),
  minScore: z.number().int().min(0).max(100).nullable(),
  maxScore: z.number().int().min(0).max(100).nullable(),
});

export const createOrgInput = orgInput.extend({
  owner: z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().email().max(254) }).optional(),
  quota: quotaInput.partial().optional(),
});

/** Creates an organization with a unique slug and code, default settings, a quota row and its default pipeline. */
export async function insertOrganization(tx: Tx, createdById: string, profile: z.infer<typeof orgInput>, quota?: z.infer<typeof createOrgInput>['quota']) {
  const base = slugify(profile.name);
  let slug = base;
  for (let i = 2; await tx.organization.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
  let code = shortCode('ORG');
  while (await tx.organization.findUnique({ where: { code } })) code = shortCode('ORG');
  const org = await tx.organization.create({
    data: {
      ...profile,
      timezone: profile.timezone ?? 'UTC',
      slug,
      code,
      createdById,
      settings: orgSettings({}) as unknown as Prisma.InputJsonValue,
      quota: { create: { ...(quota ?? {}) } },
    },
    include: { quota: true },
  });
  await provisionWorkspace(tx, org.id);
  return org;
}

export async function createOrganization(ctx: AuthContext, input: z.infer<typeof createOrgInput>) {
  const res = await createOrganizationTx(ctx, input);
  const { emitEmailEvent } = await import('./endpoints');
  const o = res.org;
  await emitEmailEvent('organization.created', { organization: { id: o.id, name: o.name, code: o.code, contactEmail: o.contactEmail, industry: o.industry }, owner: input.owner ?? null, via: 'admin' }, o.id);
  return res;
}

function createOrganizationTx(ctx: AuthContext, input: z.infer<typeof createOrgInput>) {
  return withPlatform(async (tx) => {
    const { owner, quota, ...profile } = input;
    const org = await insertOrganization(tx, ctx.user.id, profile, quota);
    const { code, slug } = org;
    await audit(tx, ctx, { action: 'org.created', targetType: 'organization', targetId: org.id, organizationId: org.id, after: { ...profile, code, slug } });

    let invite: { inviteUrl: string; email: string } | null = null;
    if (owner) {
      const role = await tx.role.findFirstOrThrow({ where: { key: 'client_owner', organizationId: null } });
      const res = await createInvitation(tx, ctx, { email: owner.email, name: owner.name, roleId: role.id, organizationId: org.id });
      invite = { inviteUrl: res.inviteUrl, email: owner.email };
    }
    return { org, invite };
  });
}

export async function updateOrganization(ctx: AuthContext, id: string, input: z.infer<typeof orgInput>) {
  return withPlatform(async (tx) => {
    const org = await tx.organization.findUnique({ where: { id } });
    if (!org) throw notFound('Organization');
    const d = diff(org as unknown as Record<string, unknown>, input);
    if (!d.changed.length) return org;
    const updated = await tx.organization.update({ where: { id }, data: input });
    await audit(tx, ctx, { action: 'org.updated', targetType: 'organization', targetId: id, organizationId: id, before: d.before, after: d.after });
    return updated;
  });
}

export const settingsInput = z.object({
  features: z.object({
    pipeline: z.boolean(), tasks: z.boolean(), communication: z.boolean(), analytics: z.boolean(),
    attachments: z.boolean(), teams: z.boolean(), email: z.boolean(), automation: z.boolean(), marketplace: z.boolean(), funnels: z.boolean(),
  }).partial().optional(),
  security: z.object({
    mfaRequired: z.boolean(),
    sessionIdleMinutes: z.number().int().min(5).max(720),
    ipAllowlist: z.array(z.string().trim().regex(/^[0-9a-fA-F:.*]+$/, 'Use an IP address or prefix ending in *').max(64)).max(100),
    revealRequiresReason: z.boolean(),
    watermark: z.boolean(),
  }).partial().optional(),
  workflows: z.object({ staleLeadDays: z.number().int().min(1).max(365), firstContactSlaHours: z.number().int().min(1).max(720) }).partial().optional(),
  branding: z.object({ primaryLabel: z.string().max(60).optional() }).optional(),
});

/**
 * Platform-side settings update (features, security requirements, workflows).
 * Client admins use `updateClientSettings`, which cannot weaken platform-imposed security.
 */
export async function updateOrgSettings(ctx: AuthContext, id: string, input: z.infer<typeof settingsInput>) {
  return withPlatform(async (tx) => {
    const org = await tx.organization.findUnique({ where: { id } });
    if (!org) throw notFound('Organization');
    const current = orgSettings(org.settings);
    const next: OrgSettings = {
      features: { ...current.features, ...(input.features ?? {}) },
      security: { ...current.security, ...(input.security ?? {}) },
      workflows: { ...current.workflows, ...(input.workflows ?? {}) },
      branding: { ...current.branding, ...(input.branding ?? {}) },
    };
    // Merge into the stored object so unrelated keys survive; MFA required by the platform is locked for workspace admins.
    const stored = { ...((org.settings as object) ?? {}), ...next, platformLocks: { mfaRequired: next.security.mfaRequired } };
    await tx.organization.update({ where: { id }, data: { settings: stored as unknown as Prisma.InputJsonValue } });
    await audit(tx, ctx, { action: 'org.settings.updated', targetType: 'organization', targetId: id, organizationId: id, before: current, after: next });
    return next;
  });
}

export async function updateQuota(ctx: AuthContext, id: string, input: z.infer<typeof quotaInput>) {
  if (input.minScore != null && input.maxScore != null && input.minScore > input.maxScore) {
    throw new AppError('VALIDATION_FAILED', 'Minimum score must be less than or equal to maximum score');
  }
  return withPlatform(async (tx) => {
    const before = await tx.clientQuota.upsert({ where: { organizationId: id }, create: { organizationId: id }, update: {} });
    const data = { ...input, pausedAt: input.capacityPaused && !before.capacityPaused ? new Date() : input.capacityPaused ? before.pausedAt : null };
    const updated = await tx.clientQuota.update({ where: { organizationId: id }, data });
    const d = diff(before as unknown as Record<string, unknown>, input);
    await audit(tx, ctx, { action: 'org.quota.updated', targetType: 'organization', targetId: id, organizationId: id, before: d.before, after: d.after });
    return updated;
  });
}

const TRANSITIONS: Record<OrgStatus, OrgStatus[]> = {
  ACTIVE: ['INACTIVE', 'SUSPENDED', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'SUSPENDED', 'ARCHIVED'],
  SUSPENDED: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: ['ACTIVE'],
};

export async function setOrgStatus(ctx: AuthContext, id: string, status: OrgStatus, reason: string) {
  const result = await withPlatform(async (tx) => {
    const org = await tx.organization.findUnique({ where: { id } });
    if (!org) throw notFound('Organization');
    if (org.status === status) return org;
    if (!TRANSITIONS[org.status].includes(status)) throw new AppError('CONFLICT', `Cannot change status from ${org.status} to ${status}`);
    const updated = await tx.organization.update({
      where: { id },
      data: { status, statusReason: reason, archivedAt: status === 'ARCHIVED' ? new Date() : status === 'ACTIVE' ? null : org.archivedAt },
    });
    await audit(tx, ctx, { action: `org.status.${status.toLowerCase()}`, targetType: 'organization', targetId: id, organizationId: id, reason, before: { status: org.status }, after: { status } });
    return updated;
  });
  if (status !== 'ACTIVE') {
    // Cut off live access immediately; future logins are blocked by the status check.
    const members = await withPlatform((tx) => tx.membership.findMany({ where: { organizationId: id }, select: { userId: true } }));
    for (const m of members) await revokeAllSessions(m.userId, `org_${status.toLowerCase()}`);
  }
  return result;
}

export async function listOrganizations(params: { q?: string; status?: OrgStatus; page: number; pageSize: number }) {
  return withPlatform(async (tx) => {
    const where: Prisma.OrganizationWhereInput = {
      ...(params.status ? { status: params.status } : {}),
      ...(params.q ? { OR: [{ name: { contains: params.q, mode: 'insensitive' } }, { code: { contains: params.q, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      tx.organization.count({ where }),
      tx.organization.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: { quota: true, _count: { select: { memberships: true } } },
      }),
    ]);
    const ids = rows.map((r) => r.id);
    const active = ids.length
      ? await tx.leadAssignment.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, status: 'ACTIVE' }, _count: true })
      : [];
    const converted = ids.length
      ? await tx.clientLead.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, revokedAt: null, status: 'CONVERTED' }, _count: true })
      : [];
    const activeMap = new Map(active.map((a) => [a.organizationId, a._count]));
    const convMap = new Map(converted.map((a) => [a.organizationId, a._count]));
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id, code: r.code, name: r.name, industry: r.industry, status: r.status, createdAt: r.createdAt,
        users: r._count.memberships, activeLeads: activeMap.get(r.id) ?? 0, converted: convMap.get(r.id) ?? 0,
        maxActiveLeads: r.quota?.maxActiveLeads ?? 0, capacityPaused: r.quota?.capacityPaused ?? false,
      })),
    };
  });
}

export async function getOrganization(id: string) {
  return withPlatform(async (tx) => {
    const org = await tx.organization.findUnique({ where: { id }, include: { quota: true } });
    if (!org) throw notFound('Organization');
    const [users, activeLeads, statusCounts, allocations30d, lastBatch] = await Promise.all([
      tx.membership.count({ where: { organizationId: id } }),
      tx.leadAssignment.count({ where: { organizationId: id, status: 'ACTIVE' } }),
      tx.clientLead.groupBy({ by: ['status'], where: { organizationId: id, revokedAt: null, archivedAt: null }, _count: true }),
      tx.leadAssignment.count({ where: { organizationId: id, assignedAt: { gte: new Date(Date.now() - 30 * 86400_000) } } }),
      tx.assignmentBatchItem.findFirst({ where: { organizationId: id, status: 'ASSIGNED' }, orderBy: { processedAt: 'desc' }, select: { processedAt: true } }),
    ]);
    return {
      org,
      settings: orgSettings(org.settings),
      stats: {
        users, activeLeads, allocations30d, lastAllocatedAt: lastBatch?.processedAt ?? null,
        byStatus: Object.fromEntries(statusCounts.map((s) => [s.status, s._count])),
      },
    };
  });
}
