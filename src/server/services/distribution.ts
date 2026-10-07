import { Prisma, type AssignmentBatch, type DistributionStrategy } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { selectionSchema, filterSchema, type Selection } from '@/lib/filters';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { shortCode } from '../crypto';
import { withPlatform, type Tx } from '../db';
import { AppError, notFound } from '../errors';
import { enqueue } from '../jobs/queues';
import { logger } from '../logger';
import { raiseAlert } from '../security/alerts';
import { getSetting } from '../settings';
import { ACTIVITY } from './activity';
import { matchesProfile, planAllocation, type PlanLead, type PlanTarget } from './allocation';
import { buildLeadWhere } from './lead-filters';
import { resolveLeadSelection } from './leads';
import { notifyPermission, notifyUsers } from './notifications';

export const STRATEGIES = ['EQUAL', 'CUSTOM', 'ROUND_ROBIN', 'WEIGHTED', 'QUOTA', 'CAPACITY', 'GEOGRAPHY', 'INDUSTRY', 'CAMPAIGN', 'SCORE'] as const;

export const targetSchema = z.object({
  organizationId: z.string().min(1).max(64),
  quantity: z.number().int().min(0).max(1_000_000).optional(),
  weight: z.number().int().min(0).max(1000).optional(),
});

export const planInput = z.object({
  selection: selectionSchema,
  strategy: z.enum(STRATEGIES),
  targets: z.array(targetSchema).min(1).max(200),
  respectQuotas: z.boolean().default(true),
  includeInvalid: z.boolean().default(false),
  /** Never give a lead to a client that held it before (default on). */
  avoidPreviousClients: z.boolean().optional(),
});

export const createInput = planInput.extend({
  idempotencyKey: z.string().min(8).max(100),
  scheduledFor: z.coerce.date().nullable().optional(),
  note: z.string().trim().max(500).optional(),
  confirmLarge: z.boolean().default(false),
});

const startOfDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};
const startOfMonth = () => {
  const d = startOfDay();
  d.setUTCDate(1);
  return d;
};

export type TargetStatus = PlanTarget & { status: string; eligible: boolean; reason: string | null; quota: { maxActiveLeads: number; dailyAllocationLimit: number; monthlyAllocationLimit: number } | null; active: number; today: number; month: number };

/** Current quota headroom and eligibility for each requested organization. */
export async function targetStatuses(tx: Tx, requested: z.infer<typeof targetSchema>[], opts: { respectQuotas: boolean; requireAuto?: boolean }): Promise<TargetStatus[]> {
  const ids = [...new Set(requested.map((t) => t.organizationId))];
  const orgs = await tx.organization.findMany({ where: { id: { in: ids } }, include: { quota: true } });
  const [active, today, month] = await Promise.all([
    tx.leadAssignment.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, status: 'ACTIVE' }, _count: true }),
    tx.leadAssignment.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, assignedAt: { gte: startOfDay() } }, _count: true }),
    tx.leadAssignment.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, assignedAt: { gte: startOfMonth() } }, _count: true }),
  ]);
  const m = (rows: { organizationId: string; _count: number }[]) => new Map(rows.map((r) => [r.organizationId, r._count]));
  const am = m(active), tm = m(today), mm = m(month);
  return requested.map((req) => {
    const o = orgs.find((x) => x.id === req.organizationId);
    const q = o?.quota;
    const a = am.get(req.organizationId) ?? 0, d = tm.get(req.organizationId) ?? 0, mo = mm.get(req.organizationId) ?? 0;
    const headroom = q ? Math.max(0, Math.min(q.maxActiveLeads - a, q.dailyAllocationLimit - d, q.monthlyAllocationLimit - mo)) : 0;
    let reason: string | null = null;
    if (!o) reason = 'Organization not found';
    else if (o.status !== 'ACTIVE') reason = `Workspace is ${o.status.toLowerCase()}`;
    else if (q?.capacityPaused) reason = 'Allocation paused (capacity)';
    else if (opts.requireAuto && q && !q.acceptsAutoDistribution) reason = 'Opted out of automated distribution';
    else if (opts.respectQuotas && headroom <= 0) reason = 'No remaining quota';
    return {
      organizationId: req.organizationId,
      name: o?.name ?? 'Unknown',
      status: o?.status ?? 'MISSING',
      quantity: req.quantity,
      weight: req.weight ?? q?.weight ?? 1,
      capacity: opts.respectQuotas ? headroom : Number.POSITIVE_INFINITY,
      regions: q?.regions ?? [], industries: q?.industries ?? [], campaigns: q?.campaigns ?? [],
      minScore: q?.minScore ?? null, maxScore: q?.maxScore ?? null,
      eligible: !reason, reason,
      quota: q ? { maxActiveLeads: q.maxActiveLeads, dailyAllocationLimit: q.dailyAllocationLimit, monthlyAllocationLimit: q.monthlyAllocationLimit } : null,
      active: a, today: d, month: mo,
    };
  });
}

const CANDIDATE_SELECT = { id: true, country: true, state: true, industry: true, campaign: true, score: true, allocationStatus: true, archivedAt: true, quality: true, mergedIntoId: true } satisfies Prisma.LeadSelect;

/** Lead → organizations that have held it before (any assignment status). */
async function previousHolders(tx: Tx, leadIds: string[]) {
  const blocked = new Map<string, Set<string>>();
  for (let i = 0; i < leadIds.length; i += 5000) {
    const rows = await tx.leadAssignment.findMany({ where: { leadId: { in: leadIds.slice(i, i + 5000) } }, select: { leadId: true, organizationId: true }, distinct: ['leadId', 'organizationId'] });
    for (const r of rows) blocked.set(r.leadId, (blocked.get(r.leadId) ?? new Set()).add(r.organizationId));
  }
  return blocked;
}

async function candidates(tx: Tx, selection: Selection, includeInvalid: boolean) {
  const ids = await resolveLeadSelection(tx, selection, {}, 'all');
  const rows: Prisma.LeadGetPayload<{ select: typeof CANDIDATE_SELECT }>[] = [];
  for (let i = 0; i < ids.length; i += 5000) {
    rows.push(...(await tx.lead.findMany({ where: { id: { in: ids.slice(i, i + 5000) } }, select: CANDIDATE_SELECT, orderBy: { createdAt: 'asc' } })));
  }
  const eligible: PlanLead[] = [];
  const skipped: { leadId: string; reason: string }[] = [];
  for (const r of rows) {
    if (r.archivedAt) skipped.push({ leadId: r.id, reason: 'Archived' });
    else if (r.allocationStatus === 'ALLOCATED') skipped.push({ leadId: r.id, reason: 'Already allocated' });
    else if (r.allocationStatus === 'PENDING') skipped.push({ leadId: r.id, reason: 'Pending in another batch' });
    else if (!includeInvalid && r.quality === 'INVALID') skipped.push({ leadId: r.id, reason: 'Invalid contact data' });
    else eligible.push({ id: r.id, country: r.country, state: r.state, industry: r.industry, campaign: r.campaign, score: r.score });
  }
  return { selected: ids.length, eligible, skipped };
}

const reasonCounts = (items: { reason: string }[]) => {
  const out: Record<string, number> = {};
  for (const i of items) out[i.reason] = (out[i.reason] ?? 0) + 1;
  return out;
};

export async function previewDistribution(input: z.infer<typeof planInput>) {
  return withPlatform(async (tx) => {
    const { selected, eligible, skipped } = await candidates(tx, input.selection, input.includeInvalid);
    const statuses = await targetStatuses(tx, input.targets, { respectQuotas: input.respectQuotas });
    const blocked = input.avoidPreviousClients === false ? undefined : await previousHolders(tx, eligible.map((l) => l.id));
    const plan = planAllocation(input.strategy, eligible, statuses.filter((s) => s.eligible), { blocked });
    const policy = await getSetting('distribution.policy');
    // A few example leads per client so the reviewer can sanity-check the split.
    const sampleIds = new Map<string, string[]>();
    for (const [leadId, org] of plan.assignments) {
      const list = sampleIds.get(org) ?? [];
      if (list.length < 4) sampleIds.set(org, [...list, leadId]);
    }
    const sampleLeads = await tx.lead.findMany({ where: { id: { in: [...sampleIds.values()].flat() } }, select: { id: true, fullName: true, company: true, country: true, industry: true, distributionCount: true } });
    const byId = new Map(sampleLeads.map((l) => [l.id, l]));
    const redistributed = eligible.filter((l) => (blocked?.get(l.id)?.size ?? 0) > 0).length;
    return {
      redistributed,
      selected,
      eligible: eligible.length,
      planned: plan.assignments.size,
      skipped: reasonCounts(skipped),
      unassigned: reasonCounts(plan.unassigned),
      largeBatch: plan.assignments.size >= policy.largeBatchThreshold,
      largeBatchThreshold: policy.largeBatchThreshold,
      targets: statuses.map((s) => ({
        organizationId: s.organizationId, name: s.name, status: s.status, eligible: s.eligible, reason: s.reason,
        capacity: Number.isFinite(s.capacity) ? s.capacity : null, active: s.active, today: s.today, quota: s.quota,
        weight: s.weight, requested: s.quantity ?? null, planned: plan.perTarget.get(s.organizationId) ?? 0,
        sample: (sampleIds.get(s.organizationId) ?? []).flatMap((id) => byId.get(id) ?? []),
      })),
    };
  }, { timeout: 60_000 });
}

/**
 * Explains a selection before distributing: how many leads are eligible, what they look like, and — for
 * every client — how many of them match the client's profile and how many the client already had.
 */
export async function selectionInsight(input: { selection: Selection; includeInvalid: boolean }) {
  return withPlatform(async (tx) => {
    const { selected, eligible, skipped } = await candidates(tx, input.selection, input.includeInvalid);
    const blocked = await previousHolders(tx, eligible.map((l) => l.id));
    const orgs = await tx.organization.findMany({ where: { status: { not: 'ARCHIVED' } }, select: { id: true }, orderBy: { name: 'asc' } });
    const statuses = await targetStatuses(tx, orgs.map((o) => ({ organizationId: o.id })), { respectQuotas: true });
    const top = (key: 'country' | 'industry' | 'campaign') => {
      const m = new Map<string, number>();
      for (const l of eligible) { const v = l[key]?.trim() || 'Unspecified'; m.set(v, (m.get(v) ?? 0) + 1); }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, count]) => ({ label, count }));
    };
    const strategies = ['GEOGRAPHY', 'INDUSTRY', 'CAMPAIGN', 'SCORE'] as const;
    return {
      selected,
      eligible: eligible.length,
      skipped: reasonCounts(skipped),
      neverDistributed: eligible.filter((l) => !blocked.has(l.id)).length,
      previouslyDistributed: eligible.filter((l) => blocked.has(l.id)).length,
      avgScore: eligible.length ? Math.round(eligible.reduce((a, l) => a + l.score, 0) / eligible.length) : 0,
      top: { countries: top('country'), industries: top('industry'), campaigns: top('campaign') },
      clients: statuses.map((t) => {
        const matches = Object.fromEntries(strategies.map((st) => [st, eligible.reduce((n, l) => n + (matchesProfile(st, l, t) ? 1 : 0), 0)]));
        const hadBefore = eligible.reduce((n, l) => n + (blocked.get(l.id)?.has(t.organizationId) ? 1 : 0), 0);
        return { organizationId: t.organizationId, matches, hadBefore };
      }),
    };
  }, { timeout: 60_000 });
}

/** Creates a durable batch. Idempotent on `idempotencyKey`; planned leads are reserved (PENDING) atomically. */
export async function createDistribution(ctx: AuthContext | null, input: z.infer<typeof createInput>, meta: { mode?: 'MANUAL' | 'RULE' | 'REASSIGN'; ruleId?: string; initiatorId?: string; offset?: number; requireAuto?: boolean } = {}) {
  const policy = await getSetting('distribution.policy');
  const initiatorId = ctx?.user.id ?? meta.initiatorId!;
  const result = await withPlatform(async (tx) => {
    const existing = await tx.assignmentBatch.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      if (existing.initiatedById !== initiatorId) throw new AppError('CONFLICT', 'Idempotency key already used');
      return { batch: existing, duplicate: true };
    }
    const { selected, eligible, skipped } = await candidates(tx, input.selection, input.includeInvalid);
    if (selected > policy.maxBatchSize) throw new AppError('VALIDATION_FAILED', `Batches are limited to ${policy.maxBatchSize.toLocaleString()} leads`);
    const statuses = await targetStatuses(tx, input.targets, { respectQuotas: input.respectQuotas, requireAuto: meta.requireAuto });
    const blocked = input.avoidPreviousClients === false ? undefined : await previousHolders(tx, eligible.map((l) => l.id));
    const plan = planAllocation(input.strategy, eligible, statuses.filter((s) => s.eligible), { offset: meta.offset, blocked });
    if (plan.assignments.size >= policy.largeBatchThreshold && !input.confirmLarge && meta.mode !== 'RULE') {
      throw new AppError('PRECONDITION_FAILED', `This batch allocates ${plan.assignments.size} leads. Large batches require explicit confirmation.`, { planned: plan.assignments.size });
    }

    // Reserve planned leads. Only leads still UNALLOCATED flip to PENDING; anything that changed concurrently is skipped.
    const plannedIds = [...plan.assignments.keys()];
    const reserved = new Set<string>();
    for (let i = 0; i < plannedIds.length; i += 5000) {
      const chunk = plannedIds.slice(i, i + 5000);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE leads SET "allocationStatus" = 'PENDING', "updatedAt" = now()
        WHERE id = ANY(${chunk}::text[]) AND "allocationStatus" = 'UNALLOCATED' AND "archivedAt" IS NULL
        RETURNING id`;
      rows.forEach((r) => reserved.add(r.id));
    }

    let code = shortCode('DST');
    while (await tx.assignmentBatch.findUnique({ where: { code } })) code = shortCode('DST');
    const scheduled = input.scheduledFor && input.scheduledFor.getTime() > Date.now() + 30_000 ? input.scheduledFor : null;
    const batch = await tx.assignmentBatch.create({
      data: {
        code,
        mode: meta.mode ?? 'MANUAL',
        strategy: input.strategy,
        selection: input.selection as unknown as Prisma.InputJsonValue,
        targets: input.targets as unknown as Prisma.InputJsonValue,
        rules: { respectQuotas: input.respectQuotas, includeInvalid: input.includeInvalid, avoidPreviousClients: input.avoidPreviousClients !== false, ineligibleTargets: statuses.filter((s) => !s.eligible).map((s) => ({ organizationId: s.organizationId, reason: s.reason })) },
        ruleId: meta.ruleId ?? null,
        idempotencyKey: input.idempotencyKey,
        status: scheduled ? 'SCHEDULED' : 'QUEUED',
        scheduledFor: scheduled,
        selectedCount: selected,
        pendingCount: reserved.size,
        skippedCount: skipped.length + plan.unassigned.length + (plannedIds.length - reserved.size),
        initiatedById: initiatorId,
        note: input.note ?? null,
      },
    });
    const items: Prisma.AssignmentBatchItemCreateManyInput[] = [
      ...plannedIds.map((leadId) => reserved.has(leadId)
        ? { batchId: batch.id, leadId, organizationId: plan.assignments.get(leadId)!, status: 'PENDING' as const }
        : { batchId: batch.id, leadId, organizationId: plan.assignments.get(leadId)!, status: 'SKIPPED' as const, reason: 'Changed during planning', processedAt: new Date() }),
      ...skipped.map((s) => ({ batchId: batch.id, leadId: s.leadId, status: 'SKIPPED' as const, reason: s.reason, processedAt: new Date() })),
      ...plan.unassigned.map((s) => ({ batchId: batch.id, leadId: s.leadId, status: 'SKIPPED' as const, reason: s.reason, processedAt: new Date() })),
    ];
    for (let i = 0; i < items.length; i += 5000) await tx.assignmentBatchItem.createMany({ data: items.slice(i, i + 5000), skipDuplicates: true });

    await audit(tx, ctx ?? { user: { id: initiatorId, email: '', name: 'automation', mfaEnabled: false } }, {
      action: 'distribution.batch.created', targetType: 'distribution_batch', targetId: batch.id, organizationId: null,
      metadata: {
        code, mode: batch.mode, strategy: input.strategy, selected, planned: reserved.size, scheduledFor: scheduled,
        perTarget: Object.fromEntries([...plan.perTarget.entries()].filter(([, n]) => n > 0)), selectionMode: input.selection.mode, ruleId: meta.ruleId,
      },
    });
    return { batch, duplicate: false };
  }, { timeout: 120_000 });

  if (!result.duplicate) {
    const delay = result.batch.scheduledFor ? Math.max(0, result.batch.scheduledFor.getTime() - Date.now()) : 0;
    await enqueue('distribution', 'execute', { batchId: result.batch.id }, { jobId: `dist-${result.batch.id}`, delay });
  }
  return result;
}

const PROJECTION_FIELDS = { fullName: true, email: true, phone: true, secondaryPhone: true, company: true, jobTitle: true, country: true, state: true, city: true, industry: true, source: true, campaign: true, score: true, priority: true } satisfies Prisma.LeadSelect;

/**
 * Worker: executes PENDING items in chunks. Each chunk locks the target organizations' quota rows
 * (serializing concurrent batches per client), re-checks capacity and lead state, then writes
 * assignment + projection + activity atomically. The partial unique index on active assignments makes
 * double allocation impossible even if this logic were bypassed.
 */
export async function executeBatch(batchId: string) {
  const batch = await withPlatform((tx) => tx.assignmentBatch.findUnique({ where: { id: batchId } }));
  if (!batch || !['QUEUED', 'SCHEDULED', 'PROCESSING'].includes(batch.status)) return null;
  const respectQuotas = (batch.rules as { respectQuotas?: boolean }).respectQuotas !== false;
  await withPlatform((tx) => tx.assignmentBatch.update({ where: { id: batchId }, data: { status: 'PROCESSING', startedAt: batch.startedAt ?? new Date() } }));
  const pausedOrgs = new Set<string>();

  for (;;) {
    const done = await withPlatform(async (tx) => {
      const items = await tx.assignmentBatchItem.findMany({ where: { batchId, status: 'PENDING' }, orderBy: { id: 'asc' }, take: 250 });
      if (!items.length) return true;
      const orgIds = [...new Set(items.map((i) => i.organizationId!))];
      await tx.$queryRaw`SELECT id FROM client_quotas WHERE "organizationId" = ANY(${orgIds}::text[]) ORDER BY "organizationId" FOR UPDATE`;
      const statuses = await targetStatuses(tx, orgIds.map((organizationId) => ({ organizationId })), { respectQuotas });
      const capacity = new Map(statuses.map((s) => [s.organizationId, s.eligible ? s.capacity : 0]));
      const reasonFor = new Map(statuses.map((s) => [s.organizationId, s.reason]));
      const pipelines = await tx.pipeline.findMany({ where: { organizationId: { in: orgIds }, isDefault: true }, include: { stages: { orderBy: { position: 'asc' }, take: 1 } } });
      const defaultStage = new Map(pipelines.map((p) => [p.organizationId, { pipelineId: p.id, stageId: p.stages[0]?.id ?? null }]));
      const leads = await tx.lead.findMany({ where: { id: { in: items.map((i) => i.leadId) } }, select: { ...PROJECTION_FIELDS, id: true, allocationStatus: true, assignedOrganizationId: true, archivedAt: true } });
      const leadMap = new Map(leads.map((l) => [l.id, l]));
      const active = batch.mode === 'REASSIGN'
        ? await tx.leadAssignment.findMany({ where: { leadId: { in: items.map((i) => i.leadId) }, status: 'ACTIVE' } })
        : [];
      const activeByLead = new Map(active.map((a) => [a.leadId, a]));

      const now = new Date();
      let assigned = 0, failed = 0, skipped = 0;
      const assignments: Prisma.LeadAssignmentCreateManyInput[] = [];
      const projections: Prisma.ClientLeadCreateManyInput[] = [];
      const activities: Prisma.ActivityCreateManyInput[] = [];
      const updates: { id: string; status: 'ASSIGNED' | 'FAILED' | 'SKIPPED'; reason: string | null; assignmentId: string | null }[] = [];
      const allocatedLeadIds: { id: string; org: string }[] = [];
      const releaseLeadIds: string[] = [];

      for (const item of items) {
        const lead = leadMap.get(item.leadId);
        const org = item.organizationId!;
        const reassign = batch.mode === 'REASSIGN';
        if (!lead || lead.archivedAt) {
          updates.push({ id: item.id, status: 'SKIPPED', reason: 'Lead no longer available', assignmentId: null });
          skipped++;
          continue;
        }
        if (!reassign && lead.allocationStatus !== 'PENDING') {
          updates.push({ id: item.id, status: 'SKIPPED', reason: 'Lead state changed', assignmentId: null });
          skipped++;
          continue;
        }
        if (reassign && lead.assignedOrganizationId === org) {
          updates.push({ id: item.id, status: 'SKIPPED', reason: 'Already held by target', assignmentId: null });
          skipped++;
          continue;
        }
        const cap = capacity.get(org) ?? 0;
        if (cap <= 0) {
          updates.push({ id: item.id, status: 'FAILED', reason: reasonFor.get(org) ?? 'Quota reached', assignmentId: null });
          failed++;
          if (!reassign) releaseLeadIds.push(lead.id);
          continue;
        }
        capacity.set(org, cap - 1);
        if (reassign) {
          const prev = activeByLead.get(lead.id);
          if (prev) {
            await tx.leadAssignment.update({ where: { id: prev.id }, data: { status: 'REASSIGNED', endedAt: now, endedById: batch.initiatedById, endedReason: batch.note ?? 'Reassigned' } });
            await tx.clientLead.updateMany({ where: { assignmentId: prev.id }, data: { revokedAt: now } });
            activities.push({ organizationId: prev.organizationId, leadId: lead.id, actorId: batch.initiatedById, type: ACTIVITY.LEAD_REASSIGNED, summary: 'Reassigned to another organization', data: { batchId } });
          }
        }
        const assignmentId = randomUUID();
        const stage = defaultStage.get(org);
        const { id: _id, allocationStatus: _a, assignedOrganizationId: _o, archivedAt: _ar, ...fields } = lead;
        assignments.push({ id: assignmentId, leadId: lead.id, organizationId: org, batchId, assignedById: batch.initiatedById, assignedAt: now, status: 'ACTIVE' });
        projections.push({ ...fields, organizationId: org, leadId: lead.id, assignmentId, pipelineId: stage?.pipelineId ?? null, stageId: stage?.stageId ?? null, stageEnteredAt: now, status: 'NEW' });
        activities.push({ organizationId: org, leadId: lead.id, actorId: batch.initiatedById, type: ACTIVITY.LEAD_ASSIGNED, summary: `Allocated via ${batch.code}`, data: { batchId, assignmentId } });
        updates.push({ id: item.id, status: 'ASSIGNED', reason: null, assignmentId });
        allocatedLeadIds.push({ id: lead.id, org });
        assigned++;
      }

      if (assignments.length) {
        await tx.leadAssignment.createMany({ data: assignments });
        await tx.clientLead.createMany({ data: projections });
        // Group lead updates by organization to keep this to a handful of statements.
        const byOrg = new Map<string, string[]>();
        for (const a of allocatedLeadIds) byOrg.set(a.org, [...(byOrg.get(a.org) ?? []), a.id]);
        for (const [org, ids] of byOrg) {
          await tx.lead.updateMany({ where: { id: { in: ids } }, data: { allocationStatus: 'ALLOCATED', assignedOrganizationId: org, clientStatus: 'NEW', lastActivityAt: now, distributionCount: { increment: 1 }, lastDistributedAt: now } });
        }
      }
      if (releaseLeadIds.length) await tx.lead.updateMany({ where: { id: { in: releaseLeadIds }, allocationStatus: 'PENDING' }, data: { allocationStatus: 'UNALLOCATED' } });
      if (activities.length) await tx.activity.createMany({ data: activities });
      await tx.$executeRaw`
        UPDATE assignment_batch_items AS i SET status = v.status::"BatchItemStatus", reason = v.reason, "assignmentId" = v.assignment_id, "processedAt" = now()
        FROM unnest(${updates.map((u) => u.id)}::text[], ${updates.map((u) => u.status)}::text[], ${updates.map((u) => u.reason)}::text[], ${updates.map((u) => u.assignmentId)}::text[]) AS v(id, status, reason, assignment_id)
        WHERE i.id = v.id`;
      await tx.assignmentBatch.update({
        where: { id: batchId },
        data: { allocatedCount: { increment: assigned }, failedCount: { increment: failed }, skippedCount: { increment: skipped }, pendingCount: { decrement: items.length } },
      });

      // Capacity-aware auto-pause.
      for (const s of statuses) {
        if ((capacity.get(s.organizationId) ?? 0) <= 0 && respectQuotas && s.eligible) {
          const q = await tx.clientQuota.findUnique({ where: { organizationId: s.organizationId } });
          if (q?.autoPauseAtCapacity && !q.capacityPaused && s.quota && s.active + assignments.filter((a) => a.organizationId === s.organizationId).length >= s.quota.maxActiveLeads) {
            await tx.clientQuota.update({ where: { id: q.id }, data: { capacityPaused: true, pausedAt: now } });
            pausedOrgs.add(s.organizationId);
          }
        }
      }
      return false;
    }, { timeout: 120_000 });
    if (done) break;
  }

  const final = await withPlatform(async (tx) => {
    const b = await tx.assignmentBatch.findUniqueOrThrow({ where: { id: batchId } });
    const status = b.allocatedCount === 0 && b.failedCount > 0 ? 'FAILED' : b.failedCount > 0 ? 'PARTIAL' : 'COMPLETED';
    const updated = await tx.assignmentBatch.update({ where: { id: batchId }, data: { status, completedAt: new Date(), pendingCount: 0 } });
    await audit(tx, { user: { id: b.initiatedById, email: '', name: 'distribution worker', mfaEnabled: false } }, {
      action: 'distribution.batch.completed', targetType: 'distribution_batch', targetId: batchId, organizationId: null,
      result: status === 'FAILED' ? 'FAILURE' : 'SUCCESS',
      metadata: { code: b.code, allocated: b.allocatedCount, failed: b.failedCount, skipped: b.skippedCount },
    });
    const perOrg = await tx.assignmentBatchItem.groupBy({ by: ['organizationId'], where: { batchId, status: 'ASSIGNED' }, _count: true });
    for (const p of perOrg) {
      if (!p.organizationId) continue;
      await notifyPermission('crm.leads.assign', p.organizationId, {
        type: 'LEADS_ALLOCATED', title: `${p._count} new lead${p._count === 1 ? '' : 's'} allocated`, body: 'Review and assign them to your team.', link: '/app/leads?view=unassigned', dedupeKey: `alloc:${batchId}:${p.organizationId}`,
      }, tx);
    }
    await notifyUsers([b.initiatedById], { type: 'DISTRIBUTION_COMPLETED', title: `Distribution ${b.code} ${status.toLowerCase()}`, body: `${b.allocatedCount} allocated · ${b.failedCount} failed · ${b.skippedCount} skipped`, link: `/admin/distribution/batches/${b.id}` }, tx);
    return updated;
  });
  for (const orgId of pausedOrgs) {
    await raiseAlert({ type: 'CLIENT_CAPACITY_REACHED', severity: 'LOW', organizationId: orgId, title: 'Client reached capacity — allocation auto-paused', details: { batchId } });
    await notifyPermission('distribution.create', null, { type: 'CAPACITY_PAUSED', title: 'A client reached capacity and was auto-paused', link: `/admin/organizations/${orgId}` });
  }
  // Workspace automation: auto-assignment and the `leads.delivered` webhook.
  const deliveredTo = await withPlatform((tx) => tx.assignmentBatchItem.groupBy({ by: ['organizationId'], where: { batchId, status: 'ASSIGNED' } }));
  const { onLeadsDelivered } = await import('./workspace-automation');
  for (const d of deliveredTo) if (d.organizationId) await onLeadsDelivered(d.organizationId, batchId);
  // Email endpoints listening for `leads.distributed`: once per client per batch.
  const counts = await withPlatform((tx) => tx.assignmentBatchItem.groupBy({ by: ['organizationId'], where: { batchId, status: 'ASSIGNED' }, _count: { _all: true } }));
  const orgs = await withPlatform((tx) => tx.organization.findMany({ where: { id: { in: counts.map((c) => c.organizationId!).filter(Boolean) } }, select: { id: true, name: true, code: true, contactEmail: true, industry: true } }));
  const { emitEmailEvent } = await import('./endpoints');
  for (const c of counts) {
    const org = orgs.find((o) => o.id === c.organizationId);
    if (org) await emitEmailEvent('leads.distributed', { organization: org, batch: { id: final.id, code: final.code }, leadCount: c._count._all }, `${batchId}:${org.id}`);
  }
  return final;
}

export async function cancelScheduledBatch(ctx: AuthContext, batchId: string, reason: string) {
  return withPlatform(async (tx) => {
    const b = await tx.assignmentBatch.findUnique({ where: { id: batchId } });
    if (!b) throw notFound('Batch');
    if (!['SCHEDULED', 'QUEUED'].includes(b.status)) throw new AppError('CONFLICT', 'Only scheduled or queued batches can be cancelled');
    const pending = await tx.assignmentBatchItem.findMany({ where: { batchId, status: 'PENDING' }, select: { leadId: true } });
    await tx.lead.updateMany({ where: { id: { in: pending.map((p) => p.leadId) }, allocationStatus: 'PENDING' }, data: { allocationStatus: 'UNALLOCATED' } });
    await tx.assignmentBatchItem.updateMany({ where: { batchId, status: 'PENDING' }, data: { status: 'SKIPPED', reason: 'Batch cancelled', processedAt: new Date() } });
    await tx.assignmentBatch.update({ where: { id: batchId }, data: { status: 'CANCELLED', pendingCount: 0, skippedCount: { increment: pending.length }, completedAt: new Date() } });
    await audit(tx, ctx, { action: 'distribution.batch.cancelled', targetType: 'distribution_batch', targetId: batchId, organizationId: null, reason });
    return { released: pending.length };
  });
}

/** Ends active assignments, hides the tenant projection and returns leads to the pool. Shared by rollback and revoke. */
async function revokeAssignments(tx: Tx, ctx: AuthContext, assignmentIds: string[], status: 'ROLLED_BACK' | 'REVOKED', reason: string) {
  if (!assignmentIds.length) return 0;
  const now = new Date();
  const rows = await tx.leadAssignment.findMany({ where: { id: { in: assignmentIds }, status: 'ACTIVE' }, select: { id: true, leadId: true, organizationId: true } });
  const ids = rows.map((r) => r.id);
  await tx.leadAssignment.updateMany({ where: { id: { in: ids } }, data: { status, endedAt: now, endedById: ctx.user.id, endedReason: reason } });
  await tx.clientLead.updateMany({ where: { assignmentId: { in: ids } }, data: { revokedAt: now } });
  await tx.lead.updateMany({ where: { id: { in: rows.map((r) => r.leadId) } }, data: { allocationStatus: 'UNALLOCATED', assignedOrganizationId: null, clientStatus: null } });
  await tx.activity.createMany({
    data: rows.map((r) => ({ organizationId: r.organizationId, leadId: r.leadId, actorId: ctx.user.id, type: ACTIVITY.LEAD_REVOKED, summary: status === 'ROLLED_BACK' ? 'Allocation rolled back' : 'Allocation revoked', data: { reason } })),
  });
  return rows.length;
}

/**
 * Controlled rollback of a batch within the configured window. Leads the client has already worked
 * (contact logged, status/stage moved, notes) are kept unless `force` is set by a sufficiently privileged user.
 */
export async function rollbackBatch(ctx: AuthContext, batchId: string, reason: string, force: boolean) {
  const policy = await getSetting('distribution.policy');
  return withPlatform(async (tx) => {
    const b = await tx.assignmentBatch.findUnique({ where: { id: batchId } });
    if (!b) throw notFound('Batch');
    if (!['COMPLETED', 'PARTIAL'].includes(b.status)) throw new AppError('CONFLICT', 'Only completed batches can be rolled back');
    const ageH = (Date.now() - (b.completedAt ?? b.createdAt).getTime()) / 3600_000;
    if (ageH > policy.rollbackWindowHours) throw new AppError('CONFLICT', `The rollback window (${policy.rollbackWindowHours}h) has passed. Use reassignment instead.`);
    if (force && ctx.role.rank < 90) throw new AppError('FORBIDDEN', 'Forced rollback requires a Super Admin or Platform Owner');

    const items = await tx.assignmentBatchItem.findMany({ where: { batchId, status: 'ASSIGNED' }, select: { id: true, assignmentId: true } });
    const assignmentIds = items.map((i) => i.assignmentId!).filter(Boolean);
    const projections = await tx.clientLead.findMany({ where: { assignmentId: { in: assignmentIds } }, select: { assignmentId: true, id: true, status: true, firstContactAt: true, _count: { select: { notes: true, comms: true } } } });
    const worked = new Set(projections.filter((p) => p.status !== 'NEW' || p.firstContactAt || p._count.notes || p._count.comms).map((p) => p.assignmentId));
    const toRevoke = force ? assignmentIds : assignmentIds.filter((a) => !worked.has(a));
    const revoked = await revokeAssignments(tx, ctx, toRevoke, 'ROLLED_BACK', reason);
    await tx.assignmentBatchItem.updateMany({ where: { batchId, assignmentId: { in: toRevoke } }, data: { status: 'ROLLED_BACK', reason: `Rolled back: ${reason}`.slice(0, 300) } });
    const fullyRolledBack = toRevoke.length === assignmentIds.length;
    await tx.assignmentBatch.update({
      where: { id: batchId },
      data: { status: fullyRolledBack ? 'ROLLED_BACK' : b.status, rolledBackAt: new Date(), rolledBackById: ctx.user.id, rollbackReason: reason, rollbackCount: { increment: revoked } },
    });
    await audit(tx, ctx, { action: 'distribution.batch.rolled_back', targetType: 'distribution_batch', targetId: batchId, organizationId: null, reason, metadata: { revoked, keptWorked: assignmentIds.length - toRevoke.length, force } });
    return { revoked, keptWorked: assignmentIds.length - toRevoke.length };
  }, { timeout: 120_000 });
}

export async function revokeLeads(ctx: AuthContext, selection: Selection, reason: string) {
  return withPlatform(async (tx) => {
    const ids = await resolveLeadSelection(tx, selection, { allocationStatus: 'ALLOCATED' }, 'all');
    const active = await tx.leadAssignment.findMany({ where: { leadId: { in: ids }, status: 'ACTIVE' }, select: { id: true } });
    const n = await revokeAssignments(tx, ctx, active.map((a) => a.id), 'REVOKED', reason);
    await audit(tx, ctx, { action: 'distribution.revoked', targetType: 'lead', organizationId: null, reason, metadata: { count: n } });
    return { revoked: n };
  }, { timeout: 120_000 });
}

/** Reassigns allocated leads to a different organization through a REASSIGN batch (same execution path, same guarantees). */
export async function reassignLeads(ctx: AuthContext, selection: Selection, toOrganizationId: string, reason: string, idempotencyKey: string, respectQuotas: boolean) {
  const policy = await getSetting('distribution.policy');
  const result = await withPlatform(async (tx) => {
    const existing = await tx.assignmentBatch.findUnique({ where: { idempotencyKey } });
    if (existing) return { batch: existing, duplicate: true };
    const ids = await resolveLeadSelection(tx, selection, { allocationStatus: 'ALLOCATED' }, 'all');
    if (!ids.length) throw new AppError('VALIDATION_FAILED', 'None of the selected leads are currently allocated');
    if (ids.length > policy.maxBatchSize) throw new AppError('VALIDATION_FAILED', 'Too many leads selected');
    const [target] = await targetStatuses(tx, [{ organizationId: toOrganizationId }], { respectQuotas });
    if (!target.eligible) throw new AppError('CONFLICT', `Target organization is not eligible: ${target.reason}`);
    let code = shortCode('RSG');
    while (await tx.assignmentBatch.findUnique({ where: { code } })) code = shortCode('RSG');
    const batch = await tx.assignmentBatch.create({
      data: {
        code, mode: 'REASSIGN', strategy: 'CUSTOM', selection: selection as unknown as Prisma.InputJsonValue,
        targets: [{ organizationId: toOrganizationId }], rules: { respectQuotas }, idempotencyKey, status: 'QUEUED',
        selectedCount: ids.length, pendingCount: ids.length, initiatedById: ctx.user.id, note: reason,
      },
    });
    await tx.assignmentBatchItem.createMany({ data: ids.map((leadId) => ({ batchId: batch.id, leadId, organizationId: toOrganizationId, status: 'PENDING' as const })) });
    await audit(tx, ctx, { action: 'distribution.reassign.created', targetType: 'distribution_batch', targetId: batch.id, organizationId: null, reason, metadata: { count: ids.length, toOrganizationId } });
    return { batch, duplicate: false };
  }, { timeout: 120_000 });
  if (!result.duplicate) await enqueue('distribution', 'execute', { batchId: result.batch.id }, { jobId: `dist-${result.batch.id}` });
  return result;
}

// ── Queries ────────────────────────────────────────────────────────

export async function listBatches(params: { page: number; pageSize: number; status?: string; organizationId?: string }) {
  return withPlatform(async (tx) => {
    const where: Prisma.AssignmentBatchWhereInput = {
      ...(params.status ? { status: params.status as AssignmentBatch['status'] } : {}),
      ...(params.organizationId ? { items: { some: { organizationId: params.organizationId } } } : {}),
    };
    const [total, rows] = await Promise.all([
      tx.assignmentBatch.count({ where }),
      tx.assignmentBatch.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
    ]);
    const users = await tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.initiatedById))] } }, select: { id: true, name: true } });
    const um = new Map(users.map((u) => [u.id, u.name]));
    return { total, rows: rows.map((r) => ({ ...r, initiatedBy: um.get(r.initiatedById) ?? 'Automation' })) };
  });
}

export async function getBatch(id: string) {
  return withPlatform(async (tx) => {
    const b = await tx.assignmentBatch.findUnique({ where: { id } });
    if (!b) throw notFound('Batch');
    const [perOrg, reasons, initiator, rolledBackBy] = await Promise.all([
      tx.assignmentBatchItem.groupBy({ by: ['organizationId', 'status'], where: { batchId: id }, _count: true }),
      tx.assignmentBatchItem.groupBy({ by: ['reason'], where: { batchId: id, status: { in: ['SKIPPED', 'FAILED'] } }, _count: true }),
      tx.user.findUnique({ where: { id: b.initiatedById }, select: { name: true, email: true } }),
      b.rolledBackById ? tx.user.findUnique({ where: { id: b.rolledBackById }, select: { name: true } }) : null,
    ]);
    const orgIds = [...new Set(perOrg.map((p) => p.organizationId).filter(Boolean) as string[])];
    const orgs = await tx.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true, code: true } });
    const byOrg = orgIds.map((oid) => {
      const o = orgs.find((x) => x.id === oid);
      const counts = Object.fromEntries(perOrg.filter((p) => p.organizationId === oid).map((p) => [p.status, p._count]));
      return { organizationId: oid, name: o?.name ?? '—', code: o?.code ?? '', ...counts };
    });
    return { batch: b, byOrg, reasons: reasons.map((r) => ({ reason: r.reason ?? 'Unspecified', count: r._count })), initiator, rolledBackBy };
  });
}

export async function listBatchItems(id: string, params: { status?: string; page: number; pageSize: number }) {
  return withPlatform(async (tx) => {
    const where: Prisma.AssignmentBatchItemWhereInput = { batchId: id, ...(params.status ? { status: params.status as 'PENDING' } : {}) };
    const [total, rows] = await Promise.all([
      tx.assignmentBatchItem.count({ where }),
      tx.assignmentBatchItem.findMany({ where, orderBy: { id: 'asc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize, include: { lead: { select: { id: true, fullName: true, company: true } } } }),
    ]);
    const orgs = await tx.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.organizationId).filter(Boolean) as string[])] } }, select: { id: true, name: true } });
    const om = new Map(orgs.map((o) => [o.id, o.name]));
    return { total, rows: rows.map((r) => ({ ...r, organization: r.organizationId ? (om.get(r.organizationId) ?? null) : null })) };
  });
}

export async function assignmentHistory(params: { organizationId?: string; leadId?: string; page: number; pageSize: number }) {
  return withPlatform(async (tx) => {
    const where: Prisma.LeadAssignmentWhereInput = { ...(params.organizationId ? { organizationId: params.organizationId } : {}), ...(params.leadId ? { leadId: params.leadId } : {}) };
    const [total, rows] = await Promise.all([
      tx.leadAssignment.count({ where }),
      tx.leadAssignment.findMany({
        where, orderBy: { assignedAt: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize,
        include: { lead: { select: { id: true, fullName: true, company: true } }, organization: { select: { id: true, name: true } }, batch: { select: { id: true, code: true } } },
      }),
    ]);
    return { total, rows };
  });
}

// ── Rules ──────────────────────────────────────────────────────────

export const ruleInput = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  strategy: z.enum(STRATEGIES).refine((s) => s !== 'CUSTOM' && s !== 'EQUAL', 'Use a rule strategy'),
  trigger: z.enum(['MANUAL', 'SCHEDULED', 'ON_IMPORT']),
  intervalMinutes: z.number().int().min(5).max(10_080).nullable().optional(),
  enabled: z.boolean(),
  config: z.object({
    filter: filterSchema,
    targets: z.array(z.object({ organizationId: z.string().max(64), weight: z.number().int().min(0).max(1000).optional() })).max(200),
    maxPerRun: z.number().int().min(1).max(50_000),
    respectQuotas: z.boolean().default(true),
    includeInvalid: z.boolean().default(false),
  }),
});

export async function upsertRule(ctx: AuthContext, id: string | null, input: z.infer<typeof ruleInput>) {
  if (input.trigger === 'SCHEDULED' && !input.intervalMinutes) throw new AppError('VALIDATION_FAILED', 'Scheduled rules need an interval');
  return withPlatform(async (tx) => {
    if (id) {
      const before = await tx.distributionRule.findUnique({ where: { id } });
      if (!before) throw notFound('Rule');
      const r = await tx.distributionRule.update({ where: { id }, data: { ...input, config: input.config as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
      await audit(tx, ctx, { action: 'distribution.rule.updated', targetType: 'distribution_rule', targetId: id, organizationId: null, before: { ...before, config: before.config }, after: input });
      return r;
    }
    const r = await tx.distributionRule.create({ data: { ...input, config: input.config as unknown as Prisma.InputJsonValue, createdById: ctx.user.id } });
    await audit(tx, ctx, { action: 'distribution.rule.created', targetType: 'distribution_rule', targetId: r.id, organizationId: null, after: input });
    return r;
  });
}

export async function runRule(ruleId: string, actor: AuthContext | null, extraFilter?: { importId?: string }, bucket?: string) {
  const rule = await withPlatform((tx) => tx.distributionRule.findUnique({ where: { id: ruleId } }));
  if (!rule) throw notFound('Rule');
  const cfg = ruleInput.shape.config.parse(rule.config);
  const actorId = actor?.user.id ?? rule.createdById;
  const targets = cfg.targets.length
    ? cfg.targets
    : (await withPlatform((tx) => tx.organization.findMany({ where: { status: 'ACTIVE', quota: { acceptsAutoDistribution: true } }, select: { id: true } }))).map((o) => ({ organizationId: o.id }));
  if (!targets.length) return null;
  const conditions = [...cfg.filter.conditions, { field: 'allocationStatus', op: 'in', value: ['UNALLOCATED'] }, { field: 'quality', op: 'in', value: cfg.includeInvalid ? ['VALID', 'INVALID'] : ['VALID'] }];
  if (extraFilter?.importId) conditions.push({ field: 'importBatchId', op: 'in', value: [extraFilter.importId] });
  // Bound the selection to maxPerRun, oldest first.
  const ids = await withPlatform((tx) => tx.lead.findMany({ where: buildLeadWhere({ q: cfg.filter.q, conditions }, 'active'), select: { id: true }, orderBy: { createdAt: 'asc' }, take: cfg.maxPerRun }));
  if (!ids.length) {
    await withPlatform((tx) => tx.distributionRule.update({ where: { id: ruleId }, data: { lastRunAt: new Date() } }));
    return null;
  }
  const priorRuns = await withPlatform((tx) => tx.assignmentBatch.count({ where: { ruleId } }));
  const res = await createDistribution(actor, {
    selection: { mode: 'ids', ids: ids.map((i) => i.id) },
    strategy: rule.strategy as DistributionStrategy,
    targets,
    respectQuotas: cfg.respectQuotas,
    includeInvalid: cfg.includeInvalid,
    idempotencyKey: `rule:${ruleId}:v${rule.version}:${bucket ?? randomUUID()}`,
    confirmLarge: true,
    note: `Rule: ${rule.name}`,
  }, { mode: 'RULE', ruleId, initiatorId: actorId, offset: priorRuns, requireAuto: true });
  await withPlatform((tx) => tx.distributionRule.update({ where: { id: ruleId }, data: { lastRunAt: new Date(), lastBatchId: res.batch.id } }));
  return res.batch;
}

/** Scheduler tick: runs enabled SCHEDULED rules whose interval has elapsed. Idempotent per time bucket. */
export async function runDueRules() {
  const rules = await withPlatform((tx) => tx.distributionRule.findMany({ where: { enabled: true, trigger: 'SCHEDULED' } }));
  let ran = 0;
  for (const r of rules) {
    const interval = (r.intervalMinutes ?? 60) * 60_000;
    if (r.lastRunAt && Date.now() - r.lastRunAt.getTime() < interval) continue;
    try {
      await runRule(r.id, null, undefined, String(Math.floor(Date.now() / interval)));
      ran++;
    } catch (err) {
      logger.error({ err, ruleId: r.id }, 'scheduled distribution rule failed');
      await raiseAlert({ type: 'DISTRIBUTION_RULE_FAILED', severity: 'MEDIUM', title: `Distribution rule failed: ${r.name}`, details: { ruleId: r.id, error: (err as Error).message }, dedupeKey: `rulefail:${r.id}:${new Date().toISOString().slice(0, 13)}` });
    }
  }
  return ran;
}

export async function runImportRules(importId: string) {
  const rules = await withPlatform((tx) => tx.distributionRule.findMany({ where: { enabled: true, trigger: 'ON_IMPORT' } }));
  for (const r of rules) {
    try {
      await runRule(r.id, null, { importId }, `import-${importId}`);
    } catch (err) {
      logger.error({ err, ruleId: r.id, importId }, 'on-import distribution rule failed');
    }
  }
}
