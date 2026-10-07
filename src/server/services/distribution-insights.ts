import { Prisma } from '@prisma/client';
import type { Filter } from '@/lib/filters';
import { maskEmail } from '@/lib/mask';
import { withPlatform } from '../db';
import { buildLeadWhere, LEAD_SORTS, pickSort } from './lead-filters';

/** "acme.com" from "https://www.acme.com/about" — the client's web domain, when one is on file. */
export function domainOf(website: string | null | undefined) {
  if (!website?.trim()) return null;
  try {
    return new URL(website.includes('://') ? website : `https://${website}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

const num = (v: unknown) => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

// ── Lead distribution tracker ──────────────────────────────────────

/**
 * Every lead's distribution trail: how many times it was allocated, to which clients (with their
 * domain/industry), what happened to each allocation and how the current client is progressing.
 */
export async function distributionTracker(params: { filter: Filter; sort?: { id: string; desc: boolean } | null; page: number; pageSize: number; includeNever?: boolean }) {
  return withPlatform(async (tx) => {
    const where: Prisma.LeadWhereInput = { AND: [buildLeadWhere(params.filter, 'all'), params.includeNever ? {} : { distributionCount: { gte: 1 } }] };
    const picked = pickSort(LEAD_SORTS, params.sort);
    const orderBy = picked ? [picked, { id: 'asc' as const }] : [{ lastDistributedAt: { sort: 'desc' as const, nulls: 'last' as const } }, { id: 'asc' as const }];
    const [total, leads] = await Promise.all([
      tx.lead.count({ where }),
      tx.lead.findMany({
        where, orderBy, skip: (params.page - 1) * params.pageSize, take: params.pageSize,
        select: {
          id: true, fullName: true, company: true, email: true, country: true, industry: true, source: true, score: true, quality: true,
          allocationStatus: true, clientStatus: true, distributionCount: true, lastDistributedAt: true, createdAt: true,
          assignments: {
            orderBy: { assignedAt: 'asc' },
            select: {
              id: true, status: true, assignedAt: true, endedAt: true, endedReason: true,
              organization: { select: { id: true, name: true, industry: true, website: true } },
              batch: { select: { id: true, code: true, strategy: true } },
              clientLead: { select: { status: true, firstContactAt: true } },
            },
          },
        },
      }),
    ]);
    return {
      total,
      rows: leads.map((l) => ({
        ...l,
        email: maskEmail(l.email),
        clients: new Set(l.assignments.map((a) => a.organization.id)).size,
        assignments: l.assignments.map((a) => ({ ...a, organization: { id: a.organization.id, name: a.organization.name, industry: a.organization.industry, domain: domainOf(a.organization.website) } })),
      })),
    };
  });
}

// ── Analytics ──────────────────────────────────────────────────────

export type InsightParams = { days: number; organizationId?: string; industry?: string };

/** Distribution tracking & analysis for the selected period (assignments made within it). */
export async function distributionAnalytics(p: InsightParams) {
  const days = Math.min(365, Math.max(1, p.days));
  const from = new Date(Date.now() - days * 86400_000);
  const prevFrom = new Date(from.getTime() - days * 86400_000);
  const orgFilter = p.organizationId ? Prisma.sql`AND a."organizationId" = ${p.organizationId}` : Prisma.empty;
  const indFilter = p.industry ? (p.industry === 'Unspecified' ? Prisma.sql`AND o.industry IS NULL` : Prisma.sql`AND o.industry = ${p.industry}`) : Prisma.empty;
  const scope = (since: Date, until: Date | null = null) => Prisma.sql`a."assignedAt" >= ${since} ${until ? Prisma.sql`AND a."assignedAt" < ${until}` : Prisma.empty} ${orgFilter} ${indFilter}`;

  return withPlatform(async (tx) => {
    const [kpi] = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT count(*) AS assignments,
             count(DISTINCT a."leadId") AS leads,
             count(DISTINCT a."organizationId") AS clients,
             count(*) FILTER (WHERE a.status = 'ACTIVE') AS active,
             count(*) FILTER (WHERE a.status = 'REVOKED') AS revoked,
             count(*) FILTER (WHERE a.status = 'REASSIGNED') AS reassigned,
             count(*) FILTER (WHERE a.status = 'ROLLED_BACK') AS rolled_back,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lead_assignments p WHERE p."leadId" = a."leadId" AND p."assignedAt" < a."assignedAt")) AS redistributed,
             count(cl.id) FILTER (WHERE cl."firstContactAt" IS NOT NULL) AS contacted,
             count(cl.id) FILTER (WHERE cl.status = 'CONVERTED') AS converted,
             avg(EXTRACT(EPOCH FROM (cl."firstContactAt" - a."assignedAt")) / 3600) FILTER (WHERE cl."firstContactAt" IS NOT NULL) AS first_contact_hours
      FROM lead_assignments a
      JOIN organizations o ON o.id = a."organizationId"
      LEFT JOIN client_leads cl ON cl."assignmentId" = a.id
      WHERE ${scope(from)}`;
    const [prev] = await tx.$queryRaw<{ assignments: unknown; leads: unknown }[]>`
      SELECT count(*) AS assignments, count(DISTINCT a."leadId") AS leads
      FROM lead_assignments a JOIN organizations o ON o.id = a."organizationId"
      WHERE ${scope(prevFrom, from)}`;

    const daily = await tx.$queryRaw<{ day: Date; org: string; n: unknown }[]>`
      SELECT date_trunc('day', a."assignedAt") AS day, a."organizationId" AS org, count(*) AS n
      FROM lead_assignments a JOIN organizations o ON o.id = a."organizationId"
      WHERE ${scope(from)}
      GROUP BY 1, 2`;

    const perClient = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT o.id, o.name, o.industry, o.website, o.status,
             count(*) AS received,
             count(DISTINCT a."leadId") AS unique_leads,
             count(*) FILTER (WHERE a.status = 'ACTIVE') AS active,
             count(*) FILTER (WHERE a.status IN ('REVOKED', 'REASSIGNED', 'ROLLED_BACK')) AS returned,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lead_assignments p WHERE p."leadId" = a."leadId" AND p."assignedAt" < a."assignedAt")) AS redistributed,
             count(cl.id) FILTER (WHERE cl."firstContactAt" IS NOT NULL) AS contacted,
             count(cl.id) FILTER (WHERE cl.status = 'CONVERTED') AS converted,
             count(cl.id) FILTER (WHERE cl.status = 'LOST') AS lost,
             avg(EXTRACT(EPOCH FROM (cl."firstContactAt" - a."assignedAt")) / 3600) FILTER (WHERE cl."firstContactAt" IS NOT NULL) AS first_contact_hours,
             count(DISTINCT a."batchId") AS batches,
             max(a."assignedAt") AS last_received
      FROM lead_assignments a
      JOIN organizations o ON o.id = a."organizationId"
      LEFT JOIN client_leads cl ON cl."assignmentId" = a.id
      WHERE ${scope(from)}
      GROUP BY o.id
      ORDER BY received DESC`;

    const byIndustry = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(o.industry, 'Unspecified') AS industry,
             count(*) AS received, count(DISTINCT a."organizationId") AS clients,
             count(cl.id) FILTER (WHERE cl."firstContactAt" IS NOT NULL) AS contacted,
             count(cl.id) FILTER (WHERE cl.status = 'CONVERTED') AS converted
      FROM lead_assignments a
      JOIN organizations o ON o.id = a."organizationId"
      LEFT JOIN client_leads cl ON cl."assignmentId" = a.id
      WHERE ${scope(from)}
      GROUP BY 1 ORDER BY received DESC LIMIT 12`;

    // How many times leads have been distributed (all-time), restricted to leads touched in the period.
    const times = await tx.$queryRaw<{ bucket: string; n: unknown }[]>`
      SELECT CASE WHEN l."distributionCount" >= 4 THEN '4+' ELSE l."distributionCount"::text END AS bucket, count(*) AS n
      FROM leads l
      WHERE l."distributionCount" >= 1 AND EXISTS (SELECT 1 FROM lead_assignments a JOIN organizations o ON o.id = a."organizationId" WHERE a."leadId" = l.id AND ${scope(from)})
      GROUP BY 1 ORDER BY 1`;
    const [pool] = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT count(*) FILTER (WHERE "allocationStatus" = 'UNALLOCATED' AND quality = 'VALID') AS ready,
             count(*) FILTER (WHERE "allocationStatus" = 'UNALLOCATED' AND "distributionCount" = 0 AND quality = 'VALID') AS never,
             count(*) FILTER (WHERE "allocationStatus" = 'UNALLOCATED' AND "distributionCount" > 0 AND quality = 'VALID') AS returned,
             count(*) FILTER (WHERE "allocationStatus" = 'PENDING') AS pending,
             count(*) FILTER (WHERE "allocationStatus" = 'ALLOCATED') AS allocated
      FROM leads WHERE "archivedAt" IS NULL AND "mergedIntoId" IS NULL`;

    const sources = await tx.$queryRaw<{ source: string; org: string; n: unknown }[]>`
      SELECT coalesce(l.source, 'Unspecified') AS source, a."organizationId" AS org, count(*) AS n
      FROM lead_assignments a
      JOIN organizations o ON o.id = a."organizationId"
      JOIN leads l ON l.id = a."leadId"
      WHERE ${scope(from)}
      GROUP BY 1, 2`;

    const batchWhere = Prisma.sql`b."createdAt" >= ${from} ${p.organizationId ? Prisma.sql`AND EXISTS (SELECT 1 FROM assignment_batch_items i WHERE i."batchId" = b.id AND i."organizationId" = ${p.organizationId})` : Prisma.empty}`;
    const batches = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT b.strategy, b.mode, count(*) AS batches, sum(b."selectedCount") AS selected, sum(b."allocatedCount") AS allocated,
             sum(b."failedCount") AS failed, sum(b."skippedCount") AS skipped, sum(b."rollbackCount") AS rolled_back
      FROM assignment_batches b WHERE ${batchWhere}
      GROUP BY 1, 2 ORDER BY allocated DESC NULLS LAST`;
    const skipReasons = await tx.$queryRaw<{ reason: string; n: unknown }[]>`
      SELECT coalesce(i.reason, 'Unknown') AS reason, count(*) AS n
      FROM assignment_batch_items i JOIN assignment_batches b ON b.id = i."batchId"
      WHERE ${batchWhere} AND i.status IN ('SKIPPED', 'FAILED')
      GROUP BY 1 ORDER BY n DESC LIMIT 8`;

    // Shape the series: total plus the three busiest clients, one point per day.
    const clientName = new Map(perClient.map((c) => [String(c.id), String(c.name)]));
    const topClients = perClient.slice(0, 3).map((c) => String(c.id));
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);
    const series = Array.from({ length: Math.min(days, 180) }, (_, i) => {
      const d = new Date(Date.now() - (Math.min(days, 180) - 1 - i) * 86400_000);
      return { date: dayKey(d), total: 0, ...Object.fromEntries(topClients.map((id) => [id, 0])) } as Record<string, number | string>;
    });
    const idx = new Map(series.map((s, i) => [s.date as string, i]));
    for (const r of daily) {
      const i = idx.get(dayKey(new Date(r.day)));
      if (i == null) continue;
      series[i].total = (series[i].total as number) + num(r.n);
      if (topClients.includes(r.org)) series[i][r.org] = (series[i][r.org] as number) + num(r.n);
    }

    // Source × client matrix (top 6 × top 6).
    const srcTotals = new Map<string, number>();
    for (const r of sources) srcTotals.set(r.source, (srcTotals.get(r.source) ?? 0) + num(r.n));
    const topSources = [...srcTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s]) => s);
    const matrixClients = perClient.slice(0, 6).map((c) => String(c.id));
    const matrix = topSources.map((src) => ({
      source: src,
      total: srcTotals.get(src) ?? 0,
      cells: matrixClients.map((org) => num(sources.find((r) => r.source === src && r.org === org)?.n)),
    }));

    const k = kpi ?? {};
    const assignments = num(k.assignments);
    return {
      range: { days, from: from.toISOString() },
      kpis: {
        assignments, previousAssignments: num(prev?.assignments), leads: num(k.leads), previousLeads: num(prev?.leads), clients: num(k.clients),
        active: num(k.active), revoked: num(k.revoked), reassigned: num(k.reassigned), rolledBack: num(k.rolled_back), redistributed: num(k.redistributed),
        contacted: num(k.contacted), converted: num(k.converted), firstContactHours: numOrNull(k.first_contact_hours),
        returnRate: assignments ? (num(k.revoked) + num(k.reassigned) + num(k.rolled_back)) / assignments : 0,
        contactRate: assignments ? num(k.contacted) / assignments : 0,
        conversionRate: assignments ? num(k.converted) / assignments : 0,
      },
      pool: { ready: num(pool?.ready), never: num(pool?.never), returned: num(pool?.returned), pending: num(pool?.pending), allocated: num(pool?.allocated) },
      series: { points: series, clients: topClients.map((id) => ({ key: id, label: clientName.get(id) ?? id })) },
      clients: perClient.map((c) => ({
        id: String(c.id), name: String(c.name), industry: (c.industry as string | null) ?? null, domain: domainOf(c.website as string | null), status: String(c.status),
        received: num(c.received), uniqueLeads: num(c.unique_leads), active: num(c.active), returned: num(c.returned), redistributed: num(c.redistributed),
        contacted: num(c.contacted), converted: num(c.converted), lost: num(c.lost), firstContactHours: numOrNull(c.first_contact_hours),
        batches: num(c.batches), lastReceived: c.last_received ? new Date(c.last_received as Date).toISOString() : null,
        share: assignments ? num(c.received) / assignments : 0,
      })),
      industries: byIndustry.map((r) => ({ industry: String(r.industry), received: num(r.received), clients: num(r.clients), contacted: num(r.contacted), converted: num(r.converted) })),
      timesDistributed: ['1', '2', '3', '4+'].map((b) => ({ bucket: b, leads: num(times.find((t) => t.bucket === b)?.n) })),
      matrix: { clients: matrixClients.map((id) => ({ id, name: clientName.get(id) ?? id })), rows: matrix },
      batches: batches.map((b) => ({ strategy: String(b.strategy), mode: String(b.mode), batches: num(b.batches), selected: num(b.selected), allocated: num(b.allocated), failed: num(b.failed), skipped: num(b.skipped), rolledBack: num(b.rolled_back) })),
      skipReasons: skipReasons.map((r) => ({ reason: r.reason, count: num(r.n) })),
    };
  }, { timeout: 60_000 });
}
