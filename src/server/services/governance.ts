import type { AlertStatus, AuditResult, Prisma } from '@prisma/client';
import { z } from 'zod';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { generateApiKey } from '../auth/apikeys';
import { prisma, withPlatform } from '../db';
import { AppError, notFound } from '../errors';
import { getSetting, invalidateSetting, SETTING_DEFAULTS, type SettingKey } from '../settings';
import { toCsv } from './normalize';

// ── Audit log ──────────────────────────────────────────────────────

export const auditQuery = z.object({
  q: z.string().trim().max(200).optional(),
  action: z.string().trim().max(100).optional(),
  actor: z.string().trim().max(200).optional(),
  organizationId: z.string().max(64).optional(),
  result: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
  targetType: z.string().max(60).optional(),
  targetId: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function auditWhere(q: z.infer<typeof auditQuery>): Prisma.AuditEventWhereInput {
  return {
    ...(q.action ? { action: { startsWith: q.action } } : {}),
    ...(q.actor ? { OR: [{ actorEmail: { contains: q.actor.toLowerCase() } }, { actorId: q.actor }] } : {}),
    ...(q.organizationId ? { organizationId: q.organizationId === 'platform' ? null : q.organizationId } : {}),
    ...(q.result ? { result: q.result as AuditResult } : {}),
    ...(q.targetType ? { targetType: q.targetType } : {}),
    ...(q.targetId ? { targetId: q.targetId } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    ...(q.q ? { OR: [{ action: { contains: q.q } }, { targetId: q.q }, { requestId: q.q }, { reason: { contains: q.q, mode: 'insensitive' } }, { actorEmail: { contains: q.q.toLowerCase() } }] } : {}),
  };
}

export async function searchAudit(q: z.infer<typeof auditQuery>, page: number, pageSize: number) {
  return withPlatform(async (tx) => {
    const where = auditWhere(q);
    const [total, rows] = await Promise.all([
      tx.auditEvent.count({ where }),
      tx.auditEvent.findMany({ where, orderBy: { seq: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    const orgs = await tx.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.organizationId).filter(Boolean) as string[])] } }, select: { id: true, name: true } });
    const om = new Map(orgs.map((o) => [o.id, o.name]));
    return { total, rows: rows.map((r) => ({ ...r, seq: r.seq.toString(), organizationName: r.organizationId ? (om.get(r.organizationId) ?? null) : null })) };
  });
}

export async function exportAudit(ctx: AuthContext, q: z.infer<typeof auditQuery>, reason: string) {
  return withPlatform(async (tx) => {
    const where = auditWhere(q);
    const count = await tx.auditEvent.count({ where });
    if (count > 100_000) throw new AppError('VALIDATION_FAILED', 'Narrow the filters: exports are limited to 100,000 events');
    const rows = await tx.auditEvent.findMany({ where, orderBy: { seq: 'asc' } });
    const csv = toCsv([
      ['seq', 'created_at', 'action', 'result', 'actor_email', 'actor_role', 'organization_id', 'target_type', 'target_id', 'reason', 'ip', 'request_id', 'before', 'after', 'metadata', 'hash', 'prev_hash'],
      ...rows.map((r) => [r.seq.toString(), r.createdAt, r.action, r.result, r.actorEmail, r.actorRole, r.organizationId, r.targetType, r.targetId, r.reason, r.ip, r.requestId, JSON.stringify(r.before ?? null), JSON.stringify(r.after ?? null), JSON.stringify(r.metadata ?? null), r.hash, r.prevHash]),
    ]);
    await audit(tx, ctx, { action: 'audit.exported', targetType: 'audit', organizationId: null, reason, metadata: { rows: rows.length, filter: q } });
    return { csv, rows: rows.length };
  }, { timeout: 120_000 });
}

export async function verifyAuditChain(ctx: AuthContext) {
  return withPlatform(async (tx) => {
    const [r] = await tx.$queryRaw<{ checked: bigint; first_broken_seq: bigint | null }[]>`SELECT * FROM audit_verify_chain()`;
    const result = { checked: Number(r.checked), intact: r.first_broken_seq === null, firstBrokenSeq: r.first_broken_seq?.toString() ?? null };
    await audit(tx, ctx, { action: 'audit.verified', targetType: 'audit', organizationId: null, result: result.intact ? 'SUCCESS' : 'FAILURE', metadata: result });
    return result;
  }, { timeout: 300_000 });
}

// ── Security center ────────────────────────────────────────────────

export async function securityOverview() {
  return withPlatform(async (tx) => {
    const day = new Date(Date.now() - 86400_000);
    const week = new Date(Date.now() - 7 * 86400_000);
    const [failed24h, locked, alertsBySev, privilege, denied24h, sessions, mfa, reveals24h, topRevealers, failedByIp, keys, policyChanges, adminAccess] = await Promise.all([
      tx.loginEvent.count({ where: { success: false, createdAt: { gt: day } } }),
      tx.user.count({ where: { lockedUntil: { gt: new Date() } } }),
      tx.securityAlert.groupBy({ by: ['severity', 'status'], _count: true }),
      tx.auditEvent.findMany({ where: { action: { in: ['user.role.changed', 'user.permission_override.set', 'role.updated', 'role.created', 'approval.approved'] }, createdAt: { gt: week } }, orderBy: { seq: 'desc' }, take: 10 }),
      tx.auditEvent.count({ where: { result: 'DENIED', createdAt: { gt: day } } }),
      tx.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
      tx.user.groupBy({ by: ['mfaEnabled', 'isPlatformUser'], where: { status: 'ACTIVE' }, _count: true }),
      tx.activity.count({ where: { type: 'FIELD_REVEALED', createdAt: { gt: day } } }),
      tx.activity.groupBy({ by: ['actorId'], where: { type: 'FIELD_REVEALED', createdAt: { gt: day } }, _count: true, orderBy: { _count: { actorId: 'desc' } }, take: 5 }),
      tx.loginEvent.groupBy({ by: ['ip'], where: { success: false, createdAt: { gt: day } }, _count: true, orderBy: { _count: { ip: 'desc' } }, take: 5 }),
      tx.apiKey.findMany({ where: { revokedAt: null }, orderBy: { lastUsedAt: { sort: 'desc', nulls: 'last' } }, take: 10, select: { id: true, name: true, prefix: true, lastUsedAt: true, lastUsedIp: true, scopes: true, expiresAt: true } }),
      tx.auditEvent.findMany({ where: { action: { startsWith: 'settings.' }, createdAt: { gt: week } }, orderBy: { seq: 'desc' }, take: 10 }),
      tx.auditEvent.findMany({ where: { action: { in: ['lead.field.revealed', 'lead.exported', 'audit.exported', 'distribution.batch.rolled_back', 'user.reset_mfa', 'user.revoke_sessions'] }, createdAt: { gt: week } }, orderBy: { seq: 'desc' }, take: 10 }),
    ]);
    const revealers = await tx.user.findMany({ where: { id: { in: topRevealers.map((t) => t.actorId).filter(Boolean) as string[] } }, select: { id: true, name: true, email: true } });
    const rm = new Map(revealers.map((r) => [r.id, r]));
    const trend = await tx.$queryRaw<{ day: Date; failed: bigint; succeeded: bigint; denied: bigint }[]>`
      WITH days AS (SELECT generate_series((now() - interval '13 days')::date, now()::date, interval '1 day')::date AS day)
      SELECT d.day,
        (SELECT count(*) FROM login_events e WHERE e."createdAt"::date = d.day AND NOT e.success) AS failed,
        (SELECT count(*) FROM login_events e WHERE e."createdAt"::date = d.day AND e.success) AS succeeded,
        (SELECT count(*) FROM audit_events a WHERE a."createdAt"::date = d.day AND a.result = 'DENIED') AS denied
      FROM days d ORDER BY d.day`;
    return {
      failed24h, locked, denied24h, sessions, reveals24h,
      alerts: alertsBySev.map((a) => ({ severity: a.severity, status: a.status, count: a._count })),
      privilege, policyChanges, adminAccess,
      mfa: mfa.map((m) => ({ enabled: m.mfaEnabled, platform: m.isPlatformUser, count: m._count })),
      topRevealers: topRevealers.map((t) => ({ user: t.actorId ? (rm.get(t.actorId) ?? null) : null, count: t._count })),
      failedByIp: failedByIp.map((f) => ({ ip: f.ip ?? 'unknown', count: f._count })),
      apiKeys: keys,
      trend: trend.map((t) => ({ day: t.day.toISOString().slice(0, 10), failed: Number(t.failed), succeeded: Number(t.succeeded), denied: Number(t.denied) })),
    };
  });
}

export async function listAlerts(params: { status?: AlertStatus | 'active'; severity?: string; page: number; pageSize: number }) {
  return withPlatform(async (tx) => {
    const where: Prisma.SecurityAlertWhereInput = {
      ...(params.status === 'active' ? { status: { in: ['OPEN', 'INVESTIGATING'] } } : params.status ? { status: params.status } : {}),
      ...(params.severity ? { severity: params.severity as 'LOW' } : {}),
    };
    const [total, rows] = await Promise.all([
      tx.securityAlert.count({ where }),
      tx.securityAlert.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
    ]);
    return { total, rows };
  });
}

export async function getAlert(id: string) {
  return withPlatform(async (tx) => {
    const alert = await tx.securityAlert.findUnique({ where: { id }, include: { notes: { orderBy: { createdAt: 'asc' } } } });
    if (!alert) throw notFound('Alert');
    const [user, org, assignee, authors] = await Promise.all([
      alert.userId ? tx.user.findUnique({ where: { id: alert.userId }, select: { id: true, name: true, email: true, status: true } }) : null,
      alert.organizationId ? tx.organization.findUnique({ where: { id: alert.organizationId }, select: { id: true, name: true, code: true } }) : null,
      alert.assigneeId ? tx.user.findUnique({ where: { id: alert.assigneeId }, select: { id: true, name: true } }) : null,
      tx.user.findMany({ where: { id: { in: alert.notes.map((n) => n.authorId) } }, select: { id: true, name: true } }),
    ]);
    // Investigation context: recent activity by the involved user / from the involved IP.
    const related = await tx.auditEvent.findMany({
      where: { OR: [...(alert.userId ? [{ actorId: alert.userId }] : []), ...(alert.ip ? [{ ip: alert.ip }] : [])], createdAt: { gt: new Date(alert.createdAt.getTime() - 3 * 86400_000) } },
      orderBy: { seq: 'desc' }, take: 40,
    });
    const logins = await tx.loginEvent.findMany({
      where: { OR: [...(alert.userId ? [{ userId: alert.userId }] : []), ...(alert.ip ? [{ ip: alert.ip }] : [])], createdAt: { gt: new Date(alert.createdAt.getTime() - 3 * 86400_000) } },
      orderBy: { createdAt: 'desc' }, take: 30,
    });
    const am = new Map(authors.map((a) => [a.id, a.name]));
    return { alert: { ...alert, notes: alert.notes.map((n) => ({ ...n, authorName: am.get(n.authorId) ?? '—' })) }, user, org, assignee, related: related.map((r) => ({ ...r, seq: r.seq.toString() })), logins };
  });
}

export async function updateAlert(ctx: AuthContext, id: string, input: { status?: AlertStatus; assigneeId?: string | null; note?: string; resolutionNote?: string }) {
  return withPlatform(async (tx) => {
    const a = await tx.securityAlert.findUnique({ where: { id } });
    if (!a) throw notFound('Alert');
    if ((input.status === 'RESOLVED' || input.status === 'DISMISSED') && !input.resolutionNote?.trim()) throw new AppError('VALIDATION_FAILED', 'Add a resolution note');
    const updated = await tx.securityAlert.update({
      where: { id },
      data: {
        ...(input.status ? { status: input.status, resolvedAt: ['RESOLVED', 'DISMISSED'].includes(input.status) ? new Date() : null } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        ...(input.resolutionNote ? { resolutionNote: input.resolutionNote } : {}),
      },
    });
    if (input.note?.trim()) await tx.securityAlertNote.create({ data: { alertId: id, authorId: ctx.user.id, body: input.note.trim().slice(0, 4000) } });
    await audit(tx, ctx, { action: 'security.alert.updated', targetType: 'security_alert', targetId: id, organizationId: null, before: { status: a.status, assigneeId: a.assigneeId }, after: { status: updated.status, assigneeId: updated.assigneeId }, reason: input.resolutionNote ?? null });
    return updated;
  });
}

// ── Platform settings ──────────────────────────────────────────────

export const settingSchemas = {
  'security.policy': z.object({
    passwordMinLength: z.number().int().min(10).max(128),
    lockoutThreshold: z.number().int().min(3).max(20),
    lockoutMinutes: z.number().int().min(1).max(1440),
    sessionAbsoluteHours: z.number().int().min(1).max(72),
    sessionIdleMinutes: z.number().int().min(5).max(720),
    mfaRequiredForPlatform: z.boolean(),
    stepUpMinutes: z.number().int().min(1).max(60),
    revealsPerHour: z.number().int().min(1).max(10_000),
    leadViewsPerHourAlert: z.number().int().min(10).max(100_000),
    forbiddenBurstThreshold: z.number().int().min(3).max(1000),
    apiRequestsPerMinute: z.number().int().min(30).max(100_000),
  }),
  'audit.retention': z.object({ days: z.number().int().min(90).max(3650) }),
  'distribution.policy': z.object({ largeBatchThreshold: z.number().int().min(10).max(100_000), rollbackWindowHours: z.number().int().min(1).max(720), maxBatchSize: z.number().int().min(100).max(50_000) }),
  'imports.policy': z.object({ fileRetentionDays: z.number().int().min(0).max(365), rowDataRetentionDays: z.number().int().min(1).max(3650), maxRows: z.number().int().min(100).max(500_000), defaultCountry: z.string().regex(/^[A-Z]{2}$/) }),
  'ai.config': z.object({ enabled: z.boolean(), provider: z.string().max(60).nullable(), allowLeadDataEgress: z.boolean() }),
  branding: z.object({
    productName: z.string().trim().min(1).max(60),
    shortName: z.string().trim().min(1).max(3),
    tagline: z.string().trim().max(80),
    showNameWithLogo: z.boolean(),
    supportEmail: z.union([z.literal(''), z.string().trim().email().max(200)]),
  }),
  seo: z.object({
    siteUrl: z.union([z.literal(''), z.string().trim().url().max(300).refine((u) => /^https?:\/\//.test(u), 'Use an http(s) URL')]).transform((u) => u.replace(/\/+$/, '')),
    defaultTitle: z.string().trim().max(120),
    titleTemplate: z.string().trim().max(120).refine((t) => t.includes('%s'), 'The title template must contain %s where the page name goes'),
    description: z.string().trim().max(320),
    keywords: z.array(z.string().trim().min(1).max(60)).max(30),
    allowIndexing: z.boolean(),
    googleVerification: z.string().trim().max(200).regex(/^[A-Za-z0-9_\-]*$/, 'Paste only the content value of the verification tag'),
    bingVerification: z.string().trim().max(200).regex(/^[A-Za-z0-9_\-]*$/, 'Paste only the content value of the verification tag'),
    sitemapEnabled: z.boolean(),
    sitemapPaths: z.array(z.string().trim().max(300).regex(/^\/[A-Za-z0-9\-._~/%]*$/, 'Sitemap entries must be paths starting with /')).max(200),
    twitterHandle: z.union([z.literal(''), z.string().trim().regex(/^@?[A-Za-z0-9_]{1,15}$/, 'Invalid handle')]),
  }),
  appearance: z.object({ defaultTheme: z.enum(['light', 'dark', 'system']), allowUserChoice: z.boolean() }),
} as const;
export type EditableSetting = keyof typeof settingSchemas;

export async function allSettings() {
  const keys = Object.keys(settingSchemas) as EditableSetting[];
  return Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await getSetting(k as SettingKey)]))) as Record<EditableSetting, unknown>;
}

export async function updateSetting(ctx: AuthContext, key: EditableSetting, value: unknown) {
  const schema = settingSchemas[key];
  const parsed = schema.parse(value);
  if (key === 'ai.config' && (parsed as { enabled: boolean }).enabled && !process.env.AI_PROVIDER_API_KEY) {
    throw new AppError('PRECONDITION_FAILED', 'AI features require AI_PROVIDER_API_KEY to be configured on the server');
  }
  const before = await getSetting(key as SettingKey);
  await withPlatform(async (tx) => {
    await tx.platformSetting.upsert({ where: { key }, create: { key, value: parsed as Prisma.InputJsonValue, updatedById: ctx.user.id }, update: { value: parsed as Prisma.InputJsonValue, updatedById: ctx.user.id } });
    await audit(tx, ctx, { action: `settings.${key}.updated`, targetType: 'platform_setting', targetId: key, organizationId: null, before, after: parsed });
  });
  invalidateSetting(key);
  return { ...SETTING_DEFAULTS[key as SettingKey], ...(parsed as object) };
}

// ── API keys, integrations, outbox ─────────────────────────────────

export async function listApiKeys() {
  return prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' }, select: { id: true, name: true, prefix: true, scopes: true, createdById: true, lastUsedAt: true, lastUsedIp: true, expiresAt: true, revokedAt: true, createdAt: true } });
}

export async function createApiKey(ctx: AuthContext, input: { name: string; scopes: string[]; expiresInDays: number | null }) {
  const allowed = new Set(['leads.read', 'imports.read', 'distribution.read', 'analytics.read', 'orgs.read']);
  const bad = input.scopes.filter((s) => !allowed.has(s) || !ctx.permissions.has(s));
  if (bad.length) throw new AppError('VALIDATION_FAILED', `Scopes not allowed: ${bad.join(', ')} (API keys are read-only and limited to permissions you hold)`);
  const k = generateApiKey();
  const row = await withPlatform(async (tx) => {
    const r = await tx.apiKey.create({
      data: { name: input.name, prefix: k.prefix, keyHash: k.hash, scopes: input.scopes, createdById: ctx.user.id, expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000) : null },
    });
    await audit(tx, ctx, { action: 'apikey.created', targetType: 'api_key', targetId: r.id, organizationId: null, after: { name: input.name, scopes: input.scopes, prefix: k.prefix } });
    return r;
  });
  // The raw key is returned exactly once and never stored.
  return { id: row.id, key: k.raw };
}

export async function revokeApiKey(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const r = await tx.apiKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!r.count) throw notFound('API key');
    await audit(tx, ctx, { action: 'apikey.revoked', targetType: 'api_key', targetId: id, organizationId: null });
  });
}

export const INTEGRATIONS = {
  SMTP: { label: 'Email (SMTP)', env: ['SMTP_URL'], description: 'Delivers invitations, password resets, notifications and scheduled reports.' },
  TWILIO_SMS: { label: 'SMS (Twilio)', env: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'], description: 'Outbound SMS from the lead workspace. Requires per-message consent checks.' },
  WHATSAPP_BUSINESS: { label: 'WhatsApp Business', env: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'], description: 'Template messages via the WhatsApp Business Cloud API.' },
  AI_PROVIDER: { label: 'AI provider', env: ['AI_PROVIDER_API_KEY'], description: 'Optional lead scoring and summarisation. Disabled until explicitly enabled and data egress is approved.' },
  OTEL: { label: 'OpenTelemetry exporter', env: ['OTEL_EXPORTER_OTLP_ENDPOINT'], description: 'Exports traces to an OTLP-compatible collector.' },
} as const;

export async function integrationStatus() {
  const rows = await prisma.integrationConfig.findMany({ where: { organizationId: null } });
  return Object.entries(INTEGRATIONS).map(([provider, def]) => {
    const missing = def.env.filter((e) => !process.env[e]);
    const row = rows.find((r) => r.provider === provider);
    return { provider, ...def, configured: missing.length === 0, missing, enabled: Boolean(row?.enabled) && missing.length === 0 };
  });
}

export async function setIntegrationEnabled(ctx: AuthContext, provider: keyof typeof INTEGRATIONS, enabled: boolean) {
  const def = INTEGRATIONS[provider];
  if (!def) throw notFound('Integration');
  if (enabled && def.env.some((e) => !process.env[e])) throw new AppError('PRECONDITION_FAILED', `Configure ${def.env.join(', ')} on the server first`);
  return withPlatform(async (tx) => {
    const existing = await tx.integrationConfig.findFirst({ where: { organizationId: null, provider } });
    if (existing) await tx.integrationConfig.update({ where: { id: existing.id }, data: { enabled } });
    else await tx.integrationConfig.create({ data: { provider, enabled, createdById: ctx.user.id } });
    await audit(tx, ctx, { action: 'integration.updated', targetType: 'integration', targetId: provider, organizationId: null, after: { enabled } });
  });
}

export async function outbox(page: number, pageSize: number) {
  const [total, rows] = await Promise.all([
    prisma.outboundEmail.count(),
    prisma.outboundEmail.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { total, rows };
}
