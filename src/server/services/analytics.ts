import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma, withPlatform, withTenant, type Tx } from '../db';
import { queue, QUEUE_NAMES } from '../jobs/queues';
import { redis } from '../redis';

/**
 * Analytics. Every figure is computed from database records at request time.
 * Platform analytics aggregate across tenants and are only reachable from platform-scoped routes;
 * client analytics always run inside `withTenant`, so RLS confines them to one organization.
 */

export const rangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  orgIds: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v ? (Array.isArray(v) ? v : [v]).filter(Boolean).slice(0, 50) : [])),
  sources: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v ? (Array.isArray(v) ? v : [v]).filter(Boolean).slice(0, 50) : [])),
  campaigns: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v ? (Array.isArray(v) ? v : [v]).filter(Boolean).slice(0, 50) : [])),
});
export type RangeInput = z.infer<typeof rangeSchema>;

export function resolveRange(r: Partial<RangeInput>) {
  const to = r.to && !Number.isNaN(r.to.getTime()) ? r.to : new Date();
  const from = r.from && !Number.isNaN(r.from.getTime()) ? r.from : new Date(to.getTime() - 30 * 86400_000);
  const toEnd = new Date(to);
  toEnd.setUTCHours(23, 59, 59, 999);
  const fromStart = new Date(from);
  fromStart.setUTCHours(0, 0, 0, 0);
  if (toEnd.getTime() - fromStart.getTime() > 400 * 86400_000) throw new Error('Range too large');
  return { from: fromStart, to: toEnd, days: Math.max(1, Math.round((toEnd.getTime() - fromStart.getTime()) / 86400_000)) };
}

const n = (v: unknown) => Number(v ?? 0);
/** Postgres numeric/avg/percentile values arrive as Decimal or string; normalise to number | null. */
const num = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const rate = (a: number, b: number) => (b > 0 ? a / b : null);

/** Lead-level SQL filter fragment for sources/campaigns/orgs (on the master `leads` table, alias l). */
function leadFilterSql(r: RangeInput) {
  const parts: Prisma.Sql[] = [Prisma.sql`l."mergedIntoId" IS NULL`];
  if (r.sources.length) parts.push(Prisma.sql`l.source = ANY(${r.sources}::text[])`);
  if (r.campaigns.length) parts.push(Prisma.sql`l.campaign = ANY(${r.campaigns}::text[])`);
  if (r.orgIds.length) parts.push(Prisma.sql`l."assignedOrganizationId" = ANY(${r.orgIds}::text[])`);
  return Prisma.join(parts, ' AND ');
}

function clientFilterSql(r: RangeInput, alias = 'c') {
  const a = Prisma.raw(alias);
  const parts: Prisma.Sql[] = [Prisma.sql`${a}."revokedAt" IS NULL`];
  if (r.sources.length) parts.push(Prisma.sql`${a}.source = ANY(${r.sources}::text[])`);
  if (r.campaigns.length) parts.push(Prisma.sql`${a}.campaign = ANY(${r.campaigns}::text[])`);
  if (r.orgIds.length) parts.push(Prisma.sql`${a}."organizationId" = ANY(${r.orgIds}::text[])`);
  return Prisma.join(parts, ' AND ');
}

// ── System health ──────────────────────────────────────────────────

export async function systemHealth() {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  try {
    const t = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    checks.push({ name: 'Database', ok: true, detail: `${Date.now() - t} ms` });
  } catch (e) {
    checks.push({ name: 'Database', ok: false, detail: (e as Error).message.slice(0, 120) });
  }
  let queues: { name: string; waiting: number; active: number; failed: number; delayed: number }[] = [];
  try {
    const t = Date.now();
    await redis().ping();
    checks.push({ name: 'Redis', ok: true, detail: `${Date.now() - t} ms` });
    const hb = await redis().get('worker:heartbeat');
    const age = hb ? (Date.now() - new Date(hb).getTime()) / 1000 : null;
    checks.push({ name: 'Background worker', ok: age !== null && age < 90, detail: age === null ? 'No heartbeat — start it with `npm run worker`' : `Heartbeat ${Math.round(age)}s ago` });
    queues = await Promise.all(
      QUEUE_NAMES.map(async (name) => {
        const c = await queue(name).getJobCounts('waiting', 'active', 'failed', 'delayed');
        return { name, waiting: c.waiting ?? 0, active: c.active ?? 0, failed: c.failed ?? 0, delayed: c.delayed ?? 0 };
      }),
    );
  } catch (e) {
    checks.push({ name: 'Redis', ok: false, detail: (e as Error).message.slice(0, 120) });
  }
  checks.push({ name: 'Email delivery', ok: Boolean(process.env.SMTP_URL), detail: process.env.SMTP_URL ? 'SMTP configured' : 'Not configured — messages stored in outbox only' });
  return { checks, queues };
}

// ── Platform command center ────────────────────────────────────────

export async function platformOverview(input: RangeInput) {
  const { from, to, days } = resolveRange(input);
  const lf = leadFilterSql(input);
  const cf = clientFilterSql(input);
  const prevFrom = new Date(from.getTime() - days * 86400_000);

  return withPlatform(async (tx) => {
    const [leadStats] = await tx.$queryRaw<Record<string, bigint>[]>`
      SELECT
        count(*) FILTER (WHERE l."archivedAt" IS NULL) AS total,
        count(*) FILTER (WHERE l."archivedAt" IS NULL AND l.quality = 'VALID') AS valid,
        count(*) FILTER (WHERE l."archivedAt" IS NULL AND l.quality = 'INVALID') AS invalid,
        count(*) FILTER (WHERE l."archivedAt" IS NULL AND l."duplicateOfId" IS NOT NULL) AS duplicate,
        count(*) FILTER (WHERE l."archivedAt" IS NOT NULL) AS archived,
        count(*) FILTER (WHERE l."archivedAt" IS NULL AND l."allocationStatus" = 'ALLOCATED') AS allocated,
        count(*) FILTER (WHERE l."archivedAt" IS NULL AND l."allocationStatus" = 'UNALLOCATED') AS unallocated,
        count(*) FILTER (WHERE l."archivedAt" IS NULL AND l."allocationStatus" = 'PENDING') AS pending,
        count(*) FILTER (WHERE l."createdAt" BETWEEN ${from} AND ${to}) AS imported_in_range,
        count(*) FILTER (WHERE l."createdAt" BETWEEN ${prevFrom} AND ${from}) AS imported_prev
      FROM leads l WHERE ${lf}`;

    const orgCounts = await tx.organization.groupBy({ by: ['status'], _count: true, ...(input.orgIds.length ? { where: { id: { in: input.orgIds } } } : {}) });
    const [users, activeSessions] = await Promise.all([
      tx.user.count({ where: { status: { in: ['ACTIVE', 'INVITED'] } } }),
      tx.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() }, mfaPending: false, lastSeenAt: { gt: new Date(Date.now() - 30 * 60_000) } } }),
    ]);

    const [dist] = await tx.$queryRaw<Record<string, bigint>[]>`
      SELECT
        count(*) FILTER (WHERE a."assignedAt" BETWEEN ${from} AND ${to}) AS allocated_in_range,
        count(*) FILTER (WHERE a."assignedAt" BETWEEN ${prevFrom} AND ${from}) AS allocated_prev,
        count(DISTINCT a."organizationId") FILTER (WHERE a."assignedAt" BETWEEN ${from} AND ${to}) AS clients_served
      FROM lead_assignments a JOIN leads l ON l.id = a."leadId" WHERE ${lf}`;
    const batches = await tx.assignmentBatch.groupBy({ by: ['status'], where: { createdAt: { gte: from, lte: to } }, _count: true });

    const [conv] = await tx.$queryRaw<Record<string, bigint>[]>`
      SELECT count(*) AS total,
        count(*) FILTER (WHERE c."firstContactAt" IS NOT NULL) AS contacted,
        count(*) FILTER (WHERE c.status IN ('QUALIFIED','NEGOTIATION','CONVERTED')) AS qualified,
        count(*) FILTER (WHERE c.status = 'CONVERTED') AS converted,
        count(*) FILTER (WHERE c.status = 'LOST') AS lost,
        count(*) FILTER (WHERE c."convertedAt" BETWEEN ${from} AND ${to}) AS converted_in_range,
        count(*) FILTER (WHERE c."nextFollowUpAt" IS NOT NULL AND c.status NOT IN ('CONVERTED','LOST')) AS with_followup,
        count(*) FILTER (WHERE c."nextFollowUpAt" < now() AND c.status NOT IN ('CONVERTED','LOST')) AS overdue_followup,
        avg(EXTRACT(EPOCH FROM (c."firstContactAt" - c."createdAt")) / 3600) FILTER (WHERE c."firstContactAt" IS NOT NULL AND c."createdAt" BETWEEN ${from} AND ${to}) AS avg_first_response_h
      FROM client_leads c WHERE ${cf} AND c."archivedAt" IS NULL`;

    const aging = await tx.$queryRaw<{ bucket: string; uncontacted: bigint; unallocated: bigint }[]>`
      WITH b(bucket, lo, hi, ord) AS (VALUES ('< 1 day',0,1,1), ('1–3 days',1,3,2), ('3–7 days',3,7,3), ('7–14 days',7,14,4), ('14–30 days',14,30,5), ('30+ days',30,100000,6))
      SELECT b.bucket,
        (SELECT count(*) FROM client_leads c WHERE ${cf} AND c."archivedAt" IS NULL AND c."firstContactAt" IS NULL AND c.status NOT IN ('CONVERTED','LOST')
           AND c."createdAt" <= now() - (b.lo || ' days')::interval AND c."createdAt" > now() - (b.hi || ' days')::interval) AS uncontacted,
        (SELECT count(*) FROM leads l WHERE ${lf} AND l."archivedAt" IS NULL AND l."allocationStatus" = 'UNALLOCATED' AND l.quality = 'VALID'
           AND l."createdAt" <= now() - (b.lo || ' days')::interval AND l."createdAt" > now() - (b.hi || ' days')::interval) AS unallocated
      FROM b ORDER BY b.ord`;

    const trend = await tx.$queryRaw<{ day: Date; imported: bigint; allocated: bigint; converted: bigint; contacted: bigint }[]>`
      WITH days AS (SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS day)
      SELECT d.day,
        (SELECT count(*) FROM leads l WHERE ${lf} AND l."createdAt"::date = d.day) AS imported,
        (SELECT count(*) FROM lead_assignments a JOIN leads l ON l.id = a."leadId" WHERE ${lf} AND a."assignedAt"::date = d.day) AS allocated,
        (SELECT count(*) FROM client_leads c WHERE ${cf} AND c."firstContactAt"::date = d.day) AS contacted,
        (SELECT count(*) FROM client_leads c WHERE ${cf} AND c."convertedAt"::date = d.day) AS converted
      FROM days d ORDER BY d.day`;

    const clients = await tx.$queryRaw<{ id: string; name: string; status: string; active: bigint; contacted: bigint; converted: bigint; overdue: bigint; max_active: number | null; last_activity: Date | null; allocated_range: bigint }[]>`
      SELECT o.id, o.name, o.status::text,
        count(c.id) FILTER (WHERE c."archivedAt" IS NULL) AS active,
        count(c.id) FILTER (WHERE c."firstContactAt" IS NOT NULL) AS contacted,
        count(c.id) FILTER (WHERE c.status = 'CONVERTED') AS converted,
        count(c.id) FILTER (WHERE c."nextFollowUpAt" < now() AND c.status NOT IN ('CONVERTED','LOST')) AS overdue,
        q."maxActiveLeads" AS max_active,
        max(c."lastActivityAt") AS last_activity,
        (SELECT count(*) FROM lead_assignments a WHERE a."organizationId" = o.id AND a."assignedAt" BETWEEN ${from} AND ${to}) AS allocated_range
      FROM organizations o
      LEFT JOIN client_quotas q ON q."organizationId" = o.id
      LEFT JOIN client_leads c ON c."organizationId" = o.id AND ${cf}
      WHERE o.status <> 'ARCHIVED' ${input.orgIds.length ? Prisma.sql`AND o.id = ANY(${input.orgIds}::text[])` : Prisma.empty}
      GROUP BY o.id, o.name, o.status, q."maxActiveLeads"
      ORDER BY active DESC LIMIT 50`;

    const [recentEvents, alerts, openAlerts, failedImports, jobFailures, sources] = await Promise.all([
      tx.auditEvent.findMany({ where: { actorId: { not: null }, action: { notIn: ['auth.login', 'auth.logout', 'auth.login.password_ok', 'auth.mfa.verified', 'auth.stepup'] } }, orderBy: { seq: 'desc' }, take: 8, select: { id: true, action: true, actorEmail: true, targetType: true, result: true, createdAt: true } }),
      tx.securityAlert.findMany({ where: { status: { in: ['OPEN', 'INVESTIGATING'] } }, orderBy: [{ createdAt: 'desc' }], take: 5 }),
      tx.securityAlert.groupBy({ by: ['severity'], where: { status: { in: ['OPEN', 'INVESTIGATING'] } }, _count: true }),
      tx.importBatch.findMany({ where: { status: 'FAILED', createdAt: { gte: prevFrom } }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, code: true, fileName: true, error: true, createdAt: true } }),
      tx.securityAlert.count({ where: { type: { in: ['JOB_FAILED', 'WORKFLOW_DEAD_LETTER'] }, status: { in: ['OPEN', 'INVESTIGATING'] } } }),
      tx.$queryRaw<{ source: string | null; leads: bigint; allocated: bigint; converted: bigint }[]>`
        SELECT l.source, count(*) AS leads, count(*) FILTER (WHERE l."allocationStatus" = 'ALLOCATED') AS allocated, count(*) FILTER (WHERE l."clientStatus" = 'CONVERTED') AS converted
        FROM leads l WHERE ${lf} AND l."archivedAt" IS NULL AND l."createdAt" BETWEEN ${from} AND ${to}
        GROUP BY l.source ORDER BY leads DESC LIMIT 10`,
    ]);
    const failedLogins24h = await tx.loginEvent.count({ where: { success: false, createdAt: { gt: new Date(Date.now() - 86400_000) } } });

    const L = Object.fromEntries(Object.entries(leadStats).map(([k, v]) => [k, n(v)]));
    const D = Object.fromEntries(Object.entries(dist).map(([k, v]) => [k, n(v)]));
    const C = Object.fromEntries(Object.entries(conv).map(([k, v]) => [k, v == null ? null : Number(v)])) as Record<string, number | null>;
    const pct = (cur: number, prev: number) => (prev > 0 ? ((cur - prev) / prev) * 100 : null);
    return {
      range: { from, to },
      leads: { ...L, importedTrend: pct(L.imported_in_range, L.imported_prev) },
      clients: Object.fromEntries(orgCounts.map((o) => [o.status, o._count])) as Record<string, number>,
      users,
      activeSessions,
      distribution: { ...D, allocatedTrend: pct(D.allocated_in_range, D.allocated_prev), batches: Object.fromEntries(batches.map((b) => [b.status, b._count])) },
      conversion: {
        total: C.total ?? 0, contacted: C.contacted ?? 0, qualified: C.qualified ?? 0, converted: C.converted ?? 0, lost: C.lost ?? 0,
        convertedInRange: C.converted_in_range ?? 0,
        contactRate: rate(C.contacted ?? 0, C.total ?? 0), qualificationRate: rate(C.qualified ?? 0, C.total ?? 0), conversionRate: rate(C.converted ?? 0, C.total ?? 0),
        avgFirstResponseHours: C.avg_first_response_h,
      },
      followUp: { withFollowUp: C.with_followup ?? 0, overdue: C.overdue_followup ?? 0, compliance: rate((C.with_followup ?? 0) - (C.overdue_followup ?? 0), C.with_followup ?? 0) },
      aging: aging.map((a) => ({ bucket: a.bucket, uncontacted: n(a.uncontacted), unallocated: n(a.unallocated) })),
      trend: trend.map((t) => ({ day: t.day.toISOString().slice(0, 10), imported: n(t.imported), allocated: n(t.allocated), contacted: n(t.contacted), converted: n(t.converted) })),
      clientTable: clients.map((c) => ({
        id: c.id, name: c.name, status: c.status, active: n(c.active), contacted: n(c.contacted), converted: n(c.converted), overdue: n(c.overdue),
        utilization: c.max_active ? n(c.active) / c.max_active : null, contactRate: rate(n(c.contacted), n(c.active)), conversionRate: rate(n(c.converted), n(c.active)),
        lastActivity: c.last_activity, allocatedInRange: n(c.allocated_range),
      })),
      sources: sources.map((s) => ({ source: s.source ?? 'Unknown', leads: n(s.leads), allocated: n(s.allocated), converted: n(s.converted) })),
      recentEvents,
      security: { alerts, open: Object.fromEntries(openAlerts.map((a) => [a.severity, a._count])), failedLogins24h },
      failures: { imports: failedImports, jobs: jobFailures },
    };
  }, { timeout: 60_000 });
}

// ── Platform analytics (deeper) ────────────────────────────────────

export async function platformAnalytics(input: RangeInput) {
  const { from, to, days } = resolveRange(input);
  const prevFrom = new Date(from.getTime() - days * 86400_000);
  const lf = leadFilterSql(input);
  const cf = clientFilterSql(input);
  return withPlatform(async (tx) => {
    const imports = await tx.$queryRaw<{ day: Date; inserted: bigint; updated: bigint; invalid: bigint; files: bigint }[]>`
      WITH days AS (SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS day)
      SELECT d.day, coalesce(sum(i."insertedCount"),0) AS inserted, coalesce(sum(i."updatedCount"),0) AS updated, coalesce(sum(i."invalidCount"),0) AS invalid, count(i.id) AS files
      FROM days d LEFT JOIN imports i ON i."createdAt"::date = d.day AND i.status IN ('COMPLETED','ROLLED_BACK')
      GROUP BY d.day ORDER BY d.day`;
    const campaigns = await tx.$queryRaw<{ campaign: string | null; leads: bigint; allocated: bigint; contacted: bigint; converted: bigint }[]>`
      SELECT l.campaign, count(*) AS leads,
        count(*) FILTER (WHERE l."allocationStatus" = 'ALLOCATED') AS allocated,
        count(*) FILTER (WHERE l."clientStatus" IN ('CONTACTED','QUALIFIED','NEGOTIATION','CONVERTED')) AS contacted,
        count(*) FILTER (WHERE l."clientStatus" = 'CONVERTED') AS converted
      FROM leads l WHERE ${lf} AND l."archivedAt" IS NULL AND l."createdAt" BETWEEN ${from} AND ${to}
      GROUP BY l.campaign ORDER BY leads DESC LIMIT 15`;
    const sources = await tx.$queryRaw<{ source: string | null; leads: bigint; invalid: bigint; allocated: bigint; converted: bigint }[]>`
      SELECT l.source, count(*) AS leads, count(*) FILTER (WHERE l.quality = 'INVALID') AS invalid,
        count(*) FILTER (WHERE l."allocationStatus" = 'ALLOCATED') AS allocated, count(*) FILTER (WHERE l."clientStatus" = 'CONVERTED') AS converted
      FROM leads l WHERE ${lf} AND l."createdAt" BETWEEN ${from} AND ${to} GROUP BY l.source ORDER BY leads DESC LIMIT 15`;
    const [efficiency] = await tx.$queryRaw<{ avg_hours: number | null; p50: number | null; p90: number | null }[]>`
      SELECT avg(EXTRACT(EPOCH FROM (a."assignedAt" - l."createdAt"))/3600) AS avg_hours,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a."assignedAt" - l."createdAt"))/3600) AS p50,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a."assignedAt" - l."createdAt"))/3600) AS p90
      FROM lead_assignments a JOIN leads l ON l.id = a."leadId" WHERE ${lf} AND a."assignedAt" BETWEEN ${from} AND ${to}`;
    const clients = await tx.$queryRaw<{ id: string; name: string; allocated: bigint; contacted: bigint; qualified: bigint; converted: bigint; lost: bigint; first_resp_h: number | null; with_fu: bigint; overdue_fu: bigint; comms: bigint; max_active: number | null; active: bigint }[]>`
      SELECT o.id, o.name,
        count(c.id) AS allocated,
        count(c.id) FILTER (WHERE c."firstContactAt" IS NOT NULL) AS contacted,
        count(c.id) FILTER (WHERE c.status IN ('QUALIFIED','NEGOTIATION','CONVERTED')) AS qualified,
        count(c.id) FILTER (WHERE c.status = 'CONVERTED') AS converted,
        count(c.id) FILTER (WHERE c.status = 'LOST') AS lost,
        avg(EXTRACT(EPOCH FROM (c."firstContactAt" - c."createdAt"))/3600) FILTER (WHERE c."firstContactAt" IS NOT NULL) AS first_resp_h,
        count(c.id) FILTER (WHERE c."nextFollowUpAt" IS NOT NULL AND c.status NOT IN ('CONVERTED','LOST')) AS with_fu,
        count(c.id) FILTER (WHERE c."nextFollowUpAt" < now() AND c.status NOT IN ('CONVERTED','LOST')) AS overdue_fu,
        (SELECT count(*) FROM communication_logs m WHERE m."organizationId" = o.id AND m."occurredAt" BETWEEN ${from} AND ${to}) AS comms,
        q."maxActiveLeads" AS max_active,
        (SELECT count(*) FROM lead_assignments a WHERE a."organizationId" = o.id AND a.status = 'ACTIVE') AS active
      FROM organizations o
      LEFT JOIN client_quotas q ON q."organizationId" = o.id
      LEFT JOIN client_leads c ON c."organizationId" = o.id AND ${cf} AND c."createdAt" BETWEEN ${from} AND ${to}
      WHERE o.status <> 'ARCHIVED' ${input.orgIds.length ? Prisma.sql`AND o.id = ANY(${input.orgIds}::text[])` : Prisma.empty}
      GROUP BY o.id, o.name, q."maxActiveLeads" ORDER BY allocated DESC LIMIT 50`;
    const cohorts = await tx.$queryRaw<{ week: Date; size: bigint; contacted: bigint; qualified: bigint; converted: bigint }[]>`
      SELECT date_trunc('week', c."createdAt") AS week, count(*) AS size,
        count(*) FILTER (WHERE c."firstContactAt" IS NOT NULL) AS contacted,
        count(*) FILTER (WHERE c.status IN ('QUALIFIED','NEGOTIATION','CONVERTED')) AS qualified,
        count(*) FILTER (WHERE c.status = 'CONVERTED') AS converted
      FROM client_leads c WHERE ${cf} AND c."createdAt" >= ${new Date(to.getTime() - 12 * 7 * 86400_000)}
      GROUP BY 1 ORDER BY 1`;
    const period = async (a: Date, b: Date) => {
      const [r] = await tx.$queryRaw<Record<string, bigint>[]>`
        SELECT (SELECT count(*) FROM leads l WHERE ${lf} AND l."createdAt" BETWEEN ${a} AND ${b}) AS imported,
               (SELECT count(*) FROM lead_assignments x JOIN leads l ON l.id = x."leadId" WHERE ${lf} AND x."assignedAt" BETWEEN ${a} AND ${b}) AS allocated,
               (SELECT count(*) FROM client_leads c WHERE ${cf} AND c."firstContactAt" BETWEEN ${a} AND ${b}) AS contacted,
               (SELECT count(*) FROM client_leads c WHERE ${cf} AND c."convertedAt" BETWEEN ${a} AND ${b}) AS converted,
               (SELECT count(*) FROM client_leads c WHERE ${cf} AND c."lostAt" BETWEEN ${a} AND ${b}) AS lost`;
      return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, n(v)]));
    };
    const [current, previous] = await Promise.all([period(from, to), period(prevFrom, from)]);
    const [funnel] = await tx.$queryRaw<Record<string, bigint>[]>`
      SELECT count(*) AS allocated,
        count(*) FILTER (WHERE c."firstContactAt" IS NOT NULL) AS contacted,
        count(*) FILTER (WHERE c.status IN ('QUALIFIED','NEGOTIATION','CONVERTED')) AS qualified,
        count(*) FILTER (WHERE c.status IN ('NEGOTIATION','CONVERTED')) AS negotiation,
        count(*) FILTER (WHERE c.status = 'CONVERTED') AS converted
      FROM client_leads c WHERE ${cf} AND c."createdAt" BETWEEN ${from} AND ${to}`;
    return {
      range: { from, to },
      imports: imports.map((r) => ({ day: r.day.toISOString().slice(0, 10), inserted: n(r.inserted), updated: n(r.updated), invalid: n(r.invalid), files: n(r.files) })),
      campaigns: campaigns.map((c) => ({ campaign: c.campaign ?? 'None', leads: n(c.leads), allocated: n(c.allocated), contacted: n(c.contacted), converted: n(c.converted) })),
      sources: sources.map((s) => ({ source: s.source ?? 'Unknown', leads: n(s.leads), invalid: n(s.invalid), allocated: n(s.allocated), converted: n(s.converted) })),
      efficiency: { avgHoursToAllocate: num(efficiency?.avg_hours), p50: num(efficiency?.p50), p90: num(efficiency?.p90) },
      clients: clients.map((c) => ({
        id: c.id, name: c.name, allocated: n(c.allocated), contacted: n(c.contacted), qualified: n(c.qualified), converted: n(c.converted), lost: n(c.lost),
        contactRate: rate(n(c.contacted), n(c.allocated)), qualificationRate: rate(n(c.qualified), n(c.allocated)), conversionRate: rate(n(c.converted), n(c.allocated)),
        firstResponseHours: num(c.first_resp_h), followUpCompliance: rate(n(c.with_fu) - n(c.overdue_fu), n(c.with_fu)), comms: n(c.comms),
        utilization: c.max_active ? n(c.active) / c.max_active : null,
      })),
      cohorts: cohorts.map((c) => ({ week: c.week.toISOString().slice(0, 10), size: n(c.size), contacted: rate(n(c.contacted), n(c.size)), qualified: rate(n(c.qualified), n(c.size)), converted: rate(n(c.converted), n(c.size)) })),
      comparison: { current, previous },
      funnel: ['allocated', 'contacted', 'qualified', 'negotiation', 'converted'].map((k) => ({ stage: k, value: n(funnel[k]) })),
    };
  }, { timeout: 60_000 });
}

// ── Custom report builder ──────────────────────────────────────────

export const REPORT_METRICS = {
  leads_imported: 'Leads imported',
  leads_allocated: 'Leads allocated',
  contacted: 'Leads contacted',
  converted: 'Leads converted',
  lost: 'Leads lost',
  comms_logged: 'Contact attempts logged',
} as const;
export const REPORT_DIMENSIONS = { day: 'Day', week: 'Week', source: 'Source', campaign: 'Campaign', organization: 'Client organization', industry: 'Industry', country: 'Country' } as const;

export const reportDefinition = z.object({
  metric: z.enum(Object.keys(REPORT_METRICS) as [keyof typeof REPORT_METRICS]),
  groupBy: z.enum(Object.keys(REPORT_DIMENSIONS) as [keyof typeof REPORT_DIMENSIONS]),
  rangeDays: z.number().int().min(1).max(366).default(30),
  sources: z.array(z.string().max(120)).max(50).default([]),
  campaigns: z.array(z.string().max(120)).max(50).default([]),
  orgIds: z.array(z.string().max(64)).max(50).default([]),
});
export type ReportDefinition = z.infer<typeof reportDefinition>;

/** Whitelisted metric × dimension combinations compiled to parameterized SQL. No user text reaches SQL identifiers. */
export async function runReport(def: ReportDefinition, organizationId?: string) {
  const to = new Date();
  const from = new Date(to.getTime() - def.rangeDays * 86400_000);
  const filters: RangeInput = { sources: def.sources, campaigns: def.campaigns, orgIds: organizationId ? [organizationId] : def.orgIds };
  const dimLead: Record<string, Prisma.Sql> = {
    day: Prisma.sql`to_char(date_trunc('day', ts), 'YYYY-MM-DD')`, week: Prisma.sql`to_char(date_trunc('week', ts), 'YYYY-MM-DD')`,
    source: Prisma.sql`coalesce(source, 'Unknown')`, campaign: Prisma.sql`coalesce(campaign, 'None')`, industry: Prisma.sql`coalesce(industry, 'Unknown')`,
    country: Prisma.sql`coalesce(country, 'Unknown')`, organization: Prisma.sql`coalesce(org_name, 'Unallocated')`,
  };
  const src = (() => {
    const lf = leadFilterSql(filters);
    const cf = clientFilterSql(filters);
    switch (def.metric) {
      case 'leads_imported':
        return Prisma.sql`SELECT l."createdAt" AS ts, l.source, l.campaign, l.industry, l.country, o.name AS org_name FROM leads l LEFT JOIN organizations o ON o.id = l."assignedOrganizationId" WHERE ${lf} AND l."createdAt" BETWEEN ${from} AND ${to}`;
      case 'leads_allocated':
        return Prisma.sql`SELECT a."assignedAt" AS ts, l.source, l.campaign, l.industry, l.country, o.name AS org_name FROM lead_assignments a JOIN leads l ON l.id = a."leadId" JOIN organizations o ON o.id = a."organizationId" WHERE ${lf} AND a."assignedAt" BETWEEN ${from} AND ${to}`;
      case 'contacted':
        return Prisma.sql`SELECT c."firstContactAt" AS ts, c.source, c.campaign, c.industry, c.country, o.name AS org_name FROM client_leads c JOIN organizations o ON o.id = c."organizationId" WHERE ${cf} AND c."firstContactAt" BETWEEN ${from} AND ${to}`;
      case 'converted':
        return Prisma.sql`SELECT c."convertedAt" AS ts, c.source, c.campaign, c.industry, c.country, o.name AS org_name FROM client_leads c JOIN organizations o ON o.id = c."organizationId" WHERE ${cf} AND c."convertedAt" BETWEEN ${from} AND ${to}`;
      case 'lost':
        return Prisma.sql`SELECT c."lostAt" AS ts, c.source, c.campaign, c.industry, c.country, o.name AS org_name FROM client_leads c JOIN organizations o ON o.id = c."organizationId" WHERE ${cf} AND c."lostAt" BETWEEN ${from} AND ${to}`;
      case 'comms_logged':
        return Prisma.sql`SELECT m."occurredAt" AS ts, c.source, c.campaign, c.industry, c.country, o.name AS org_name FROM communication_logs m JOIN client_leads c ON c.id = m."clientLeadId" JOIN organizations o ON o.id = m."organizationId" WHERE ${cf} AND m."occurredAt" BETWEEN ${from} AND ${to}`;
    }
  })();
  const run = async (tx: Tx) => {
    const rows = await tx.$queryRaw<{ label: string; value: bigint }[]>`SELECT ${dimLead[def.groupBy]} AS label, count(*) AS value FROM (${src}) s GROUP BY 1 ORDER BY ${def.groupBy === 'day' || def.groupBy === 'week' ? Prisma.sql`1 ASC` : Prisma.sql`2 DESC`} LIMIT 400`;
    return rows.map((r) => ({ label: r.label, value: n(r.value) }));
  };
  // Client-scoped reports never touch the master leads table (RLS would hide it anyway).
  if (organizationId) {
    if (def.metric === 'leads_imported' || def.metric === 'leads_allocated') throw new Error('Metric not available in workspace reports');
    if (def.groupBy === 'organization') throw new Error('Dimension not available in workspace reports');
    return withTenant(organizationId, run);
  }
  return withPlatform(run);
}

// ── Client workspace analytics ─────────────────────────────────────

export async function clientDashboard(organizationId: string, opts: { userId: string; ownOnly: boolean }) {
  return withTenant(organizationId, async (tx) => {
    const own = opts.ownOnly ? Prisma.sql`AND c."ownerId" = ${opts.userId}` : Prisma.empty;
    const [s] = await tx.$queryRaw<Record<string, bigint>[]>`
      SELECT count(*) AS total,
        count(*) FILTER (WHERE c.status = 'NEW') AS new,
        count(*) FILTER (WHERE c."firstContactAt" IS NULL AND c.status NOT IN ('CONVERTED','LOST')) AS uncontacted,
        count(*) FILTER (WHERE c."firstContactAt" IS NOT NULL) AS ever_contacted,
        count(*) FILTER (WHERE c.status = 'CONTACTED') AS contacted,
        count(*) FILTER (WHERE c.status = 'QUALIFIED') AS qualified,
        count(*) FILTER (WHERE c.status = 'NEGOTIATION') AS negotiation,
        count(*) FILTER (WHERE c.status = 'CONVERTED') AS converted,
        count(*) FILTER (WHERE c.status = 'LOST') AS lost,
        count(*) FILTER (WHERE c."nextFollowUpAt" < now() AND c.status NOT IN ('CONVERTED','LOST')) AS overdue_followups,
        count(*) FILTER (WHERE c."ownerId" IS NULL AND c.status NOT IN ('CONVERTED','LOST')) AS unassigned,
        count(*) FILTER (WHERE c."createdAt" > now() - interval '7 days') AS new_7d
      FROM client_leads c WHERE c."organizationId" = ${organizationId} AND c."revokedAt" IS NULL AND c."archivedAt" IS NULL ${own}`;
    const ownTask = opts.ownOnly ? { assigneeId: opts.userId } : {};
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const [tasksDue, tasksOverdue] = await Promise.all([
      tx.task.count({ where: { organizationId, status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { gte: new Date(), lte: endOfDay }, ...ownTask } }),
      tx.task.count({ where: { organizationId, status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { lt: new Date() }, ...ownTask } }),
    ]);
    const pipeline = await tx.$queryRaw<{ id: string; name: string; category: string; position: number; count: bigint; value: Prisma.Decimal | null }[]>`
      SELECT s.id, s.name, s.category::text, s.position, count(c.id) AS count, sum(c."dealValue") AS value
      FROM pipeline_stages s JOIN pipelines p ON p.id = s."pipelineId" AND p."isDefault"
      LEFT JOIN client_leads c ON c."stageId" = s.id AND c."revokedAt" IS NULL AND c."archivedAt" IS NULL ${own}
      WHERE s."organizationId" = ${organizationId} GROUP BY s.id ORDER BY s.position`;
    const aging = await tx.$queryRaw<{ bucket: string; count: bigint }[]>`
      WITH b(bucket, lo, hi, ord) AS (VALUES ('< 1 day',0,1,1), ('1–3 days',1,3,2), ('3–7 days',3,7,3), ('7–14 days',7,14,4), ('14+ days',14,100000,5))
      SELECT b.bucket, (SELECT count(*) FROM client_leads c WHERE c."organizationId" = ${organizationId} AND c."revokedAt" IS NULL AND c."archivedAt" IS NULL
        AND c."firstContactAt" IS NULL AND c.status NOT IN ('CONVERTED','LOST') ${own}
        AND c."createdAt" <= now() - (b.lo || ' days')::interval AND c."createdAt" > now() - (b.hi || ' days')::interval) AS count
      FROM b ORDER BY b.ord`;
    const team = await tx.$queryRaw<{ user_id: string; comms: bigint; notes: bigint; tasks_done: bigint }[]>`
      SELECT u.id AS user_id,
        (SELECT count(*) FROM communication_logs m WHERE m."organizationId" = ${organizationId} AND m."userId" = u.id AND m."occurredAt" > now() - interval '7 days') AS comms,
        (SELECT count(*) FROM lead_notes n WHERE n."organizationId" = ${organizationId} AND n."authorId" = u.id AND n."createdAt" > now() - interval '7 days') AS notes,
        (SELECT count(*) FROM tasks t WHERE t."organizationId" = ${organizationId} AND t."completedById" = u.id AND t."completedAt" > now() - interval '7 days') AS tasks_done
      FROM users u JOIN memberships mb ON mb."userId" = u.id WHERE mb."organizationId" = ${organizationId} AND u.status = 'ACTIVE'`;
    const users = await tx.user.findMany({ where: { id: { in: team.map((t) => t.user_id) } }, select: { id: true, name: true } });
    const um = new Map(users.map((u) => [u.id, u.name]));
    const recent = await tx.activity.findMany({
      where: { organizationId, type: { notIn: ['LEAD_VIEWED'] }, ...(opts.ownOnly ? { actorId: opts.userId } : {}) },
      orderBy: { createdAt: 'desc' }, take: 12,
    });
    const actorNames = await tx.user.findMany({ where: { id: { in: [...new Set(recent.map((r) => r.actorId).filter(Boolean) as string[])] } }, select: { id: true, name: true } });
    const an = new Map(actorNames.map((u) => [u.id, u.name]));
    const S = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, n(v)]));
    return {
      stats: { ...S, tasksDue, tasksOverdue },
      pipeline: pipeline.map((p) => ({ id: p.id, name: p.name, category: p.category, count: n(p.count), value: p.value ? Number(p.value) : 0 })),
      funnel: [
        { stage: 'Allocated', value: S.total },
        { stage: 'Contacted', value: S.ever_contacted },
        { stage: 'Qualified', value: S.qualified + S.negotiation + S.converted },
        { stage: 'Negotiation', value: S.negotiation + S.converted },
        { stage: 'Converted', value: S.converted },
      ],
      aging: aging.map((a) => ({ bucket: a.bucket, count: n(a.count) })),
      team: opts.ownOnly ? [] : team.map((t) => ({ name: um.get(t.user_id) ?? '—', comms: n(t.comms), notes: n(t.notes), tasksDone: n(t.tasks_done) })).sort((a, b) => b.comms - a.comms),
      recent: recent.map((r) => ({ ...r, actorName: r.actorId ? (an.get(r.actorId) ?? 'Team member') : 'System' })),
    };
  });
}

export async function clientAnalytics(organizationId: string, input: RangeInput) {
  const { from, to, days } = resolveRange(input);
  const prevFrom = new Date(from.getTime() - days * 86400_000);
  return withTenant(organizationId, async (tx) => {
    const base = Prisma.sql`c."organizationId" = ${organizationId} AND c."revokedAt" IS NULL`;
    const trend = await tx.$queryRaw<{ day: Date; acquired: bigint; contacted: bigint; converted: bigint }[]>`
      WITH days AS (SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS day)
      SELECT d.day,
        (SELECT count(*) FROM client_leads c WHERE ${base} AND c."createdAt"::date = d.day) AS acquired,
        (SELECT count(*) FROM client_leads c WHERE ${base} AND c."firstContactAt"::date = d.day) AS contacted,
        (SELECT count(*) FROM client_leads c WHERE ${base} AND c."convertedAt"::date = d.day) AS converted
      FROM days d ORDER BY d.day`;
    const rates = async (a: Date, b: Date) => {
      const [r] = await tx.$queryRaw<Record<string, bigint | number | null>[]>`
        SELECT count(*) AS acquired,
          count(*) FILTER (WHERE c."firstContactAt" IS NOT NULL) AS contacted,
          count(*) FILTER (WHERE c.status IN ('QUALIFIED','NEGOTIATION','CONVERTED')) AS qualified,
          count(*) FILTER (WHERE c.status = 'CONVERTED') AS converted,
          count(*) FILTER (WHERE c.status = 'LOST') AS lost,
          avg(EXTRACT(EPOCH FROM (c."firstContactAt" - c."createdAt"))/3600) FILTER (WHERE c."firstContactAt" IS NOT NULL) AS first_resp_h,
          count(*) FILTER (WHERE c."nextFollowUpAt" IS NOT NULL AND c.status NOT IN ('CONVERTED','LOST')) AS with_fu,
          count(*) FILTER (WHERE c."nextFollowUpAt" < now() AND c.status NOT IN ('CONVERTED','LOST')) AS overdue_fu
        FROM client_leads c WHERE ${base} AND c."createdAt" BETWEEN ${a} AND ${b}`;
      const x = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? null : Number(v)])) as Record<string, number | null>;
      return {
        acquired: x.acquired ?? 0, contacted: x.contacted ?? 0, qualified: x.qualified ?? 0, converted: x.converted ?? 0, lost: x.lost ?? 0,
        contactRate: rate(x.contacted ?? 0, x.acquired ?? 0), qualificationRate: rate(x.qualified ?? 0, x.acquired ?? 0), conversionRate: rate(x.converted ?? 0, x.acquired ?? 0),
        firstResponseHours: x.first_resp_h, followUpCompliance: rate((x.with_fu ?? 0) - (x.overdue_fu ?? 0), x.with_fu ?? 0),
      };
    };
    const [current, previous] = await Promise.all([rates(from, to), rates(prevFrom, from)]);
    const sources = await tx.$queryRaw<{ source: string | null; leads: bigint; contacted: bigint; converted: bigint; value: Prisma.Decimal | null }[]>`
      SELECT c.source, count(*) AS leads, count(*) FILTER (WHERE c."firstContactAt" IS NOT NULL) AS contacted, count(*) FILTER (WHERE c.status = 'CONVERTED') AS converted, sum(c."dealValue") FILTER (WHERE c.status = 'CONVERTED') AS value
      FROM client_leads c WHERE ${base} AND c."createdAt" BETWEEN ${from} AND ${to} GROUP BY c.source ORDER BY leads DESC LIMIT 12`;
    const people = await tx.$queryRaw<{ id: string; leads: bigint; contacted: bigint; converted: bigint; comms: bigint; tasks_done: bigint; value: Prisma.Decimal | null }[]>`
      SELECT u.id,
        (SELECT count(*) FROM client_leads c WHERE ${base} AND c."ownerId" = u.id AND c."archivedAt" IS NULL) AS leads,
        (SELECT count(*) FROM client_leads c WHERE ${base} AND c."ownerId" = u.id AND c."firstContactAt" BETWEEN ${from} AND ${to}) AS contacted,
        (SELECT count(*) FROM client_leads c WHERE ${base} AND c."ownerId" = u.id AND c."convertedAt" BETWEEN ${from} AND ${to}) AS converted,
        (SELECT count(*) FROM communication_logs m WHERE m."organizationId" = ${organizationId} AND m."userId" = u.id AND m."occurredAt" BETWEEN ${from} AND ${to}) AS comms,
        (SELECT count(*) FROM tasks t WHERE t."organizationId" = ${organizationId} AND t."completedById" = u.id AND t."completedAt" BETWEEN ${from} AND ${to}) AS tasks_done,
        (SELECT sum(c."dealValue") FROM client_leads c WHERE ${base} AND c."ownerId" = u.id AND c.status = 'CONVERTED' AND c."convertedAt" BETWEEN ${from} AND ${to}) AS value
      FROM users u JOIN memberships mb ON mb."userId" = u.id WHERE mb."organizationId" = ${organizationId} AND u.status = 'ACTIVE'`;
    const users = await tx.user.findMany({ where: { id: { in: people.map((p) => p.id) } }, select: { id: true, name: true } });
    const um = new Map(users.map((u) => [u.id, u.name]));
    const lostReasons = await tx.$queryRaw<{ reason: string | null; count: bigint }[]>`
      SELECT coalesce(nullif(trim(c."lostReason"), ''), 'Not specified') AS reason, count(*) AS count FROM client_leads c WHERE ${base} AND c.status = 'LOST' AND c."lostAt" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`;
    const pipeline = await tx.$queryRaw<{ name: string; count: bigint; value: Prisma.Decimal | null; weighted: Prisma.Decimal | null }[]>`
      SELECT s.name, count(c.id) AS count, sum(c."dealValue") AS value, sum(c."dealValue" * coalesce(c.probability, s.probability) / 100.0) AS weighted
      FROM pipeline_stages s JOIN pipelines p ON p.id = s."pipelineId" AND p."isDefault"
      LEFT JOIN client_leads c ON c."stageId" = s.id AND ${base} AND c."archivedAt" IS NULL
      WHERE s."organizationId" = ${organizationId} AND s.category = 'OPEN' GROUP BY s.id ORDER BY s.position`;
    return {
      range: { from, to },
      trend: trend.map((t) => ({ day: t.day.toISOString().slice(0, 10), acquired: n(t.acquired), contacted: n(t.contacted), converted: n(t.converted) })),
      current, previous,
      sources: sources.map((s) => ({ source: s.source ?? 'Unknown', leads: n(s.leads), contacted: n(s.contacted), converted: n(s.converted), contactRate: rate(n(s.contacted), n(s.leads)), conversionRate: rate(n(s.converted), n(s.leads)), value: s.value ? Number(s.value) : 0 })),
      people: people.map((p) => ({ name: um.get(p.id) ?? '—', leads: n(p.leads), contacted: n(p.contacted), converted: n(p.converted), comms: n(p.comms), tasksDone: n(p.tasks_done), value: p.value ? Number(p.value) : 0 })).sort((a, b) => b.converted - a.converted || b.comms - a.comms),
      lostReasons: lostReasons.map((l) => ({ reason: l.reason ?? 'Not specified', count: n(l.count) })),
      pipeline: pipeline.map((p) => ({ name: p.name, count: n(p.count), value: p.value ? Number(p.value) : 0, weighted: p.weighted ? Number(p.weighted) : 0 })),
    };
  }, { timeout: 30_000 });
}
