import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Filter, Selection } from '@/lib/filters';
import { maskEmail, maskPhone, type SensitiveField } from '@/lib/mask';
import { audit, diff } from '../audit';
import type { AuthContext } from '../auth/context';
import { withPlatform, type Tx } from '../db';
import { AppError, notFound } from '../errors';
import { rateLimit } from '../ratelimit';
import { onLeadAccess } from '../security/alerts';
import { getSetting } from '../settings';
import { ACTIVITY, recordActivity } from './activity';
import { buildLeadWhere, LEAD_SORTS, pickSort, type LeadView } from './lead-filters';
import { cleanText, normalizeEmail, normalizePhone, toCsv } from './normalize';

export const MAX_SELECTION = 50_000;

const LIST_SELECT = {
  id: true, fullName: true, email: true, phone: true, company: true, jobTitle: true, country: true, state: true, city: true,
  industry: true, source: true, campaign: true, score: true, priority: true, quality: true, qualityIssues: true,
  allocationStatus: true, assignedOrganizationId: true, clientStatus: true, duplicateOfId: true, importBatchId: true,
  lastActivityAt: true, nextFollowUpAt: true, archivedAt: true, createdAt: true, updatedAt: true,
  distributionCount: true, lastDistributedAt: true,
  tags: { select: { tag: { select: { id: true, name: true } } } },
  enrichment: { select: { status: true, confidence: true } },
} satisfies Prisma.LeadSelect;

type ListRow = Prisma.LeadGetPayload<{ select: typeof LIST_SELECT }>;

function present(row: ListRow, orgNames: Map<string, string>) {
  return {
    ...row,
    email: maskEmail(row.email),
    phone: maskPhone(row.phone),
    tags: row.tags.map((t) => t.tag),
    assignedOrganization: row.assignedOrganizationId ? (orgNames.get(row.assignedOrganizationId) ?? null) : null,
  };
}

async function orgNameMap(tx: Tx, ids: (string | null)[]) {
  const unique = [...new Set(ids.filter(Boolean) as string[])];
  if (!unique.length) return new Map<string, string>();
  const orgs = await tx.organization.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(orgs.map((o) => [o.id, o.name]));
}

export async function listLeads(params: { filter: Filter; view: LeadView; sort?: { id: string; desc: boolean } | null; page: number; pageSize: number }) {
  return withPlatform(async (tx) => {
    const where = buildLeadWhere(params.filter, params.view);
    const picked = pickSort(LEAD_SORTS, params.sort);
    const orderBy = picked ? [picked, { id: 'asc' as const }] : [{ createdAt: 'desc' as const }, { id: 'asc' as const }];
    const [total, rows] = await Promise.all([
      tx.lead.count({ where }),
      tx.lead.findMany({ where, orderBy, skip: (params.page - 1) * params.pageSize, take: params.pageSize, select: LIST_SELECT }),
    ]);
    const names = await orgNameMap(tx, rows.map((r) => r.assignedOrganizationId));
    return { total, rows: rows.map((r) => present(r, names)) };
  });
}

/** Facet values for filter builders (distinct sources, campaigns, etc.). Bounded and cached by the caller. */
export async function leadFacets() {
  return withPlatform(async (tx) => {
    const distinct = async (field: 'source' | 'campaign' | 'industry' | 'country') => {
      const rows = await tx.lead.groupBy({ by: [field], where: { [field]: { not: null }, mergedIntoId: null }, _count: true, orderBy: { _count: { [field]: 'desc' } }, take: 100 });
      return rows.map((r) => r[field] as string);
    };
    const [sources, campaigns, industries, countries, tags, orgs, imports] = await Promise.all([
      distinct('source'), distinct('campaign'), distinct('industry'), distinct('country'),
      tx.tag.findMany({ where: { organizationId: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      tx.organization.findMany({ where: { status: { not: 'ARCHIVED' } }, orderBy: { name: 'asc' }, select: { id: true, name: true, status: true } }),
      tx.importBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, code: true, fileName: true } }),
    ]);
    return { sources, campaigns, industries, countries, tags, orgs, imports };
  });
}

/** Resolves a bulk selection to concrete lead ids, server-side, bounded. Never trusts a client-side count. */
export async function resolveLeadSelection(tx: Tx, selection: Selection, extra: Prisma.LeadWhereInput = {}, view: LeadView = 'active') {
  const where: Prisma.LeadWhereInput =
    selection.mode === 'ids'
      ? { AND: [{ id: { in: selection.ids } }, { mergedIntoId: null }, extra] }
      : { AND: [buildLeadWhere(selection.filter, view), selection.excludeIds.length ? { id: { notIn: selection.excludeIds } } : {}, extra] };
  const count = await tx.lead.count({ where });
  if (count > MAX_SELECTION) throw new AppError('VALIDATION_FAILED', `Selections are limited to ${MAX_SELECTION.toLocaleString()} leads. Narrow your filters.`);
  const rows = await tx.lead.findMany({ where, select: { id: true }, orderBy: { createdAt: 'asc' } });
  return rows.map((r) => r.id);
}

export async function getLeadDetail(ctx: AuthContext, id: string) {
  const result = await withPlatform(async (tx) => {
    const lead = await tx.lead.findUnique({
      where: { id },
      include: {
        tags: { include: { tag: true } },
        importBatch: { select: { id: true, code: true, fileName: true } },
        assignments: { orderBy: { assignedAt: 'desc' }, include: { organization: { select: { id: true, name: true, code: true } }, batch: { select: { id: true, code: true } } } },
      },
    });
    if (!lead) throw notFound('Lead');
    const [activities, duplicates, projections] = await Promise.all([
      tx.activity.findMany({ where: { leadId: id }, orderBy: { createdAt: 'desc' }, take: 100 }),
      tx.lead.findMany({
        where: {
          id: { not: id }, mergedIntoId: null,
          OR: [
            ...(lead.emailNormalized ? [{ emailNormalized: lead.emailNormalized }] : []),
            ...(lead.phoneNormalized ? [{ phoneNormalized: lead.phoneNormalized }] : []),
          ],
        },
        take: 10,
        select: { id: true, fullName: true, company: true, allocationStatus: true, createdAt: true, archivedAt: true },
      }),
      tx.clientLead.findMany({ where: { leadId: id }, select: { id: true, organizationId: true, status: true, stageId: true, ownerId: true, revokedAt: true, lastActivityAt: true, firstContactAt: true } }),
    ]);
    const actorIds = [...new Set(activities.map((a) => a.actorId).filter(Boolean) as string[])];
    const actors = actorIds.length ? await tx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
    const orgIds = [...new Set(activities.map((a) => a.organizationId).filter(Boolean) as string[])];
    const orgs = await orgNameMap(tx, orgIds);
    await recordActivity(tx, { leadId: id, actorId: ctx.user.id, type: ACTIVITY.LEAD_VIEWED, summary: 'Viewed by platform staff' });
    return { lead, activities, duplicates: lead.emailNormalized || lead.phoneNormalized ? duplicates : [], projections, actors: new Map(actors.map((a) => [a.id, a.name])), orgs };
  });
  await onLeadAccess(ctx.user.id, null, ctx.ip, 'view');
  const { lead } = result;
  return {
    lead: {
      ...lead,
      email: maskEmail(lead.email),
      phone: maskPhone(lead.phone),
      secondaryPhone: maskPhone(lead.secondaryPhone),
      emailNormalized: undefined,
      phoneNormalized: undefined,
      tags: lead.tags.map((t) => ({ id: t.tag.id, name: t.tag.name })),
      hasEmail: Boolean(lead.email),
      hasPhone: Boolean(lead.phone),
      hasSecondaryPhone: Boolean(lead.secondaryPhone),
    },
    activities: result.activities.map((a) => ({ ...a, actorName: a.actorId ? (result.actors.get(a.actorId) ?? 'Unknown user') : 'System', organizationName: a.organizationId ? (result.orgs.get(a.organizationId) ?? null) : null })),
    duplicates: result.duplicates,
    projections: result.projections,
  };
}

/** Returns a raw sensitive value. Permission-checked by the route, rate limited, and audited. */
export async function revealLeadField(ctx: AuthContext, id: string, field: SensitiveField, reason?: string) {
  const policy = await getSetting('security.policy');
  const lim = await rateLimit(`reveal:${ctx.user.id}`, policy.revealsPerHour, 3600);
  if (!lim.ok) throw new AppError('RATE_LIMITED', 'Reveal limit reached for this hour. This has been logged.');
  const value = await withPlatform(async (tx) => {
    const lead = await tx.lead.findUnique({ where: { id }, select: { id: true, email: true, phone: true, secondaryPhone: true } });
    if (!lead) throw notFound('Lead');
    await recordActivity(tx, { leadId: id, actorId: ctx.user.id, type: ACTIVITY.FIELD_REVEALED, summary: `Revealed ${field}`, data: { field } });
    await audit(tx, ctx, { action: 'lead.field.revealed', targetType: 'lead', targetId: id, organizationId: null, reason: reason ?? null, metadata: { field } });
    return lead[field];
  });
  await onLeadAccess(ctx.user.id, null, ctx.ip, 'reveal');
  return { field, value };
}

export const leadEditInput = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  secondaryPhone: z.string().trim().max(40).nullable().optional(),
  company: z.string().trim().max(200).nullable().optional(),
  jobTitle: z.string().trim().max(120).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  state: z.string().trim().max(80).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  industry: z.string().trim().max(80).nullable().optional(),
  source: z.string().trim().max(120).nullable().optional(),
  campaign: z.string().trim().max(120).nullable().optional(),
  score: z.number().int().min(0).max(100).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  customFields: z.record(z.string().max(60), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])).optional(),
});

function normalizeEdit(input: z.infer<typeof leadEditInput>, defaultCountry: string) {
  const data: Prisma.LeadUpdateInput = {};
  const issues: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (k === 'email') {
      const e = normalizeEmail(v);
      if (v && e.error) throw new AppError('VALIDATION_FAILED', e.error);
      data.email = v ? String(v).trim() : null;
      data.emailNormalized = e.value;
    } else if (k === 'phone') {
      const p = normalizePhone(v, defaultCountry);
      if (v && p.error) throw new AppError('VALIDATION_FAILED', p.error);
      data.phone = v ? String(v).trim() : null;
      data.phoneNormalized = p.value;
    } else if (k === 'secondaryPhone') {
      const p = normalizePhone(v, defaultCountry);
      if (v && p.error) throw new AppError('VALIDATION_FAILED', 'Invalid secondary phone number');
      data.secondaryPhone = p.value ?? null;
    } else if (typeof v === 'string') {
      (data as Record<string, unknown>)[k] = cleanText(v, 200);
    } else {
      (data as Record<string, unknown>)[k] = v;
    }
  }
  return { data, issues };
}

export async function createLead(ctx: AuthContext, input: z.infer<typeof leadEditInput> & { fullName: string }) {
  const { defaultCountry } = await getSetting('imports.policy');
  const { data } = normalizeEdit(input, defaultCountry);
  return withPlatform(async (tx) => {
    const lead = await tx.lead.create({ data: { ...(data as Prisma.LeadCreateInput), fullName: input.fullName, createdById: ctx.user.id } });
    await recordActivity(tx, { leadId: lead.id, actorId: ctx.user.id, type: ACTIVITY.LEAD_CREATED, summary: 'Created manually' });
    await audit(tx, ctx, { action: 'lead.created', targetType: 'lead', targetId: lead.id, organizationId: null, after: { fullName: lead.fullName, source: lead.source } });
    return lead;
  }).then(async (lead) => {
    await import('./announcements').then((m) => m.scheduleNewLeadsAnnouncement(10 * 60_000)).catch(() => null);
    return lead;
  });
}

export async function updateLead(ctx: AuthContext, id: string, input: z.infer<typeof leadEditInput>) {
  const { defaultCountry } = await getSetting('imports.policy');
  const { data } = normalizeEdit(input, defaultCountry);
  return withPlatform(async (tx) => {
    const lead = await tx.lead.findUnique({ where: { id } });
    if (!lead) throw notFound('Lead');
    const d = diff(lead as unknown as Record<string, unknown>, data as Record<string, unknown>);
    if (!d.changed.length) return lead;
    const touchedQuality = 'emailNormalized' in data || 'phoneNormalized' in data;
    const updated = await tx.lead.update({ where: { id }, data });
    if (touchedQuality) {
      const issues = [...(updated.email && !updated.emailNormalized ? ['Invalid email address'] : []), ...(updated.phone && !updated.phoneNormalized ? ['Invalid phone number'] : [])];
      if (!updated.emailNormalized && !updated.phoneNormalized) issues.push('No valid contact method');
      await tx.lead.update({ where: { id }, data: { quality: issues.length ? 'INVALID' : 'VALID', qualityIssues: issues } });
    }
    const masked = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !['email', 'phone', 'secondaryPhone', 'emailNormalized', 'phoneNormalized'].includes(k)));
    await recordActivity(tx, { leadId: id, actorId: ctx.user.id, type: ACTIVITY.LEAD_EDITED, summary: `Edited ${d.changed.filter((k) => !k.endsWith('Normalized')).join(', ')}` });
    await audit(tx, ctx, {
      action: 'lead.updated', targetType: 'lead', targetId: id, organizationId: null,
      before: masked(d.before), after: masked(d.after),
      metadata: { changed: d.changed, contactFieldsChanged: d.changed.some((k) => ['email', 'phone', 'secondaryPhone'].includes(k)) },
    });
    return updated;
  });
}

export async function archiveLeads(ctx: AuthContext, selection: Selection, archive: boolean, reason: string) {
  return withPlatform(async (tx) => {
    const ids = await resolveLeadSelection(tx, selection, {}, archive ? 'active' : 'archived');
    if (!ids.length) return { updated: 0, skipped: 0 };
    // Allocated leads must be revoked from the client before archival.
    const eligible = archive ? await tx.lead.findMany({ where: { id: { in: ids }, allocationStatus: 'UNALLOCATED' }, select: { id: true } }) : ids.map((id) => ({ id }));
    const eligibleIds = eligible.map((e) => e.id);
    await tx.lead.updateMany({ where: { id: { in: eligibleIds } }, data: archive ? { archivedAt: new Date(), archivedReason: reason } : { archivedAt: null, archivedReason: null } });
    await tx.activity.createMany({
      data: eligibleIds.map((leadId) => ({ leadId, actorId: ctx.user.id, type: archive ? ACTIVITY.LEAD_ARCHIVED : ACTIVITY.LEAD_RESTORED, verification: 'SYSTEM_VERIFIED' as const, summary: archive ? `Archived: ${reason}` : 'Restored', data: {} })),
    });
    await audit(tx, ctx, {
      action: archive ? 'lead.bulk.archived' : 'lead.bulk.restored', targetType: 'lead', targetId: eligibleIds.length === 1 ? eligibleIds[0] : null, organizationId: null, reason,
      metadata: { count: eligibleIds.length, skippedAllocated: ids.length - eligibleIds.length, selectionMode: selection.mode, sample: eligibleIds.slice(0, 20) },
    });
    return { updated: eligibleIds.length, skipped: ids.length - eligibleIds.length };
  }, { timeout: 120_000 });
}

export async function tagLeads(ctx: AuthContext, selection: Selection, add: string[], remove: string[]) {
  return withPlatform(async (tx) => {
    const ids = await resolveLeadSelection(tx, selection);
    const addTags: { id: string; name: string }[] = [];
    for (const name of [...new Set(add.map((t) => t.trim()).filter(Boolean))]) {
      const existing = await tx.tag.findFirst({ where: { organizationId: null, name } });
      addTags.push(existing ?? (await tx.tag.create({ data: { name, organizationId: null } })));
    }
    if (addTags.length) {
      await tx.leadTag.createMany({ data: ids.flatMap((leadId) => addTags.map((t) => ({ leadId, tagId: t.id }))), skipDuplicates: true });
    }
    if (remove.length) {
      await tx.leadTag.deleteMany({ where: { leadId: { in: ids }, tagId: { in: remove } } });
    }
    await audit(tx, ctx, { action: 'lead.bulk.tagged', targetType: 'lead', organizationId: null, metadata: { count: ids.length, added: addTags.map((t) => t.name), removedTagIds: remove } });
    return { updated: ids.length };
  }, { timeout: 120_000 });
}

/** Merges duplicates into a primary record. Empty fields on the primary are filled from duplicates; duplicates are archived with a pointer to the primary. */
export async function mergeLeads(ctx: AuthContext, primaryId: string, duplicateIds: string[], reason: string) {
  const ids = [...new Set(duplicateIds)].filter((d) => d !== primaryId);
  if (!ids.length) throw new AppError('VALIDATION_FAILED', 'Select at least one duplicate to merge');
  return withPlatform(async (tx) => {
    const primary = await tx.lead.findUnique({ where: { id: primaryId } });
    if (!primary || primary.mergedIntoId) throw notFound('Primary lead');
    const dups = await tx.lead.findMany({ where: { id: { in: ids }, mergedIntoId: null } });
    if (dups.length !== ids.length) throw new AppError('CONFLICT', 'Some duplicates no longer exist or were already merged');
    const allocated = dups.filter((d) => d.allocationStatus !== 'UNALLOCATED');
    if (allocated.length) throw new AppError('CONFLICT', `Revoke allocations before merging: ${allocated.map((d) => d.fullName).join(', ')}`);

    const FILL: (keyof typeof primary)[] = ['email', 'emailNormalized', 'phone', 'phoneNormalized', 'secondaryPhone', 'company', 'jobTitle', 'country', 'state', 'city', 'industry', 'source', 'campaign'];
    const patch: Record<string, unknown> = {};
    for (const f of FILL) {
      if (primary[f] == null || primary[f] === '') {
        const donor = dups.find((d) => d[f] != null && d[f] !== '');
        if (donor) patch[f] = donor[f];
      }
    }
    const maxScore = Math.max(primary.score, ...dups.map((d) => d.score));
    if (maxScore !== primary.score) patch.score = maxScore;
    patch.customFields = Object.assign({}, ...dups.map((d) => d.customFields as object), primary.customFields as object);
    await tx.lead.update({ where: { id: primaryId }, data: patch });
    const dupTags = await tx.leadTag.findMany({ where: { leadId: { in: ids } } });
    await tx.leadTag.createMany({ data: dupTags.map((t) => ({ leadId: primaryId, tagId: t.tagId })), skipDuplicates: true });
    await tx.lead.updateMany({ where: { id: { in: ids } }, data: { mergedIntoId: primaryId, duplicateOfId: primaryId, archivedAt: new Date(), archivedReason: `Merged into ${primaryId}` } });
    await recordActivity(tx, { leadId: primaryId, actorId: ctx.user.id, type: ACTIVITY.LEAD_MERGED, summary: `Merged ${ids.length} duplicate(s)`, data: { merged: ids, filledFields: Object.keys(patch).filter((k) => !k.endsWith('Normalized')) } });
    for (const d of dups) {
      await recordActivity(tx, { leadId: d.id, actorId: ctx.user.id, type: ACTIVITY.LEAD_MERGED, summary: `Merged into ${primary.fullName}`, data: { primaryId } });
    }
    await audit(tx, ctx, {
      action: 'lead.merged', targetType: 'lead', targetId: primaryId, organizationId: null, reason,
      before: { duplicates: dups.map((d) => ({ id: d.id, fullName: d.fullName, company: d.company, source: d.source, createdAt: d.createdAt })) },
      after: { filled: Object.keys(patch).filter((k) => !k.endsWith('Normalized') && !['email', 'phone', 'secondaryPhone'].includes(k)) },
    });
    return { merged: ids.length };
  });
}

export async function duplicateGroups(params: { page: number; pageSize: number }) {
  return withPlatform(async (tx) => {
    const groups = await tx.$queryRaw<{ key: string; kind: string; n: bigint; ids: string[] }[]>`
      SELECT key, kind, n, ids FROM (
        SELECT "emailNormalized" AS key, 'email' AS kind, count(*) AS n, array_agg(id ORDER BY "createdAt") AS ids
          FROM leads WHERE "emailNormalized" IS NOT NULL AND "mergedIntoId" IS NULL AND "archivedAt" IS NULL GROUP BY "emailNormalized" HAVING count(*) > 1
        UNION ALL
        SELECT "phoneNormalized", 'phone', count(*), array_agg(id ORDER BY "createdAt")
          FROM leads WHERE "phoneNormalized" IS NOT NULL AND "mergedIntoId" IS NULL AND "archivedAt" IS NULL GROUP BY "phoneNormalized" HAVING count(*) > 1
      ) g ORDER BY n DESC, key LIMIT ${params.pageSize} OFFSET ${(params.page - 1) * params.pageSize}`;
    const [{ total }] = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT (SELECT count(*) FROM (SELECT 1 FROM leads WHERE "emailNormalized" IS NOT NULL AND "mergedIntoId" IS NULL AND "archivedAt" IS NULL GROUP BY "emailNormalized" HAVING count(*) > 1) a)
           + (SELECT count(*) FROM (SELECT 1 FROM leads WHERE "phoneNormalized" IS NOT NULL AND "mergedIntoId" IS NULL AND "archivedAt" IS NULL GROUP BY "phoneNormalized" HAVING count(*) > 1) b) AS total`;
    const allIds = groups.flatMap((g) => g.ids.slice(0, 10));
    const leads = await tx.lead.findMany({
      where: { id: { in: allIds } },
      select: { id: true, fullName: true, company: true, source: true, allocationStatus: true, createdAt: true, assignedOrganizationId: true },
    });
    const byId = new Map(leads.map((l) => [l.id, l]));
    return {
      total: Number(total),
      groups: groups.map((g) => ({
        kind: g.kind,
        key: g.kind === 'email' ? maskEmail(g.key) : maskPhone(g.key),
        count: Number(g.n),
        leads: g.ids.slice(0, 10).map((id) => byId.get(id)).filter(Boolean),
      })),
    };
  });
}

/**
 * Administrative export. Requires `leads.export` and a recent step-up. Contact fields are only
 * included unmasked when the caller also holds `leads.reveal`. Cells are formula-escaped.
 */
export async function exportLeadsCsv(ctx: AuthContext, filter: Filter, view: LeadView, reason: string) {
  const includeContacts = ctx.permissions.has('leads.reveal');
  return withPlatform(async (tx) => {
    const where = buildLeadWhere(filter, view);
    const count = await tx.lead.count({ where });
    if (count > MAX_SELECTION) throw new AppError('VALIDATION_FAILED', `Exports are limited to ${MAX_SELECTION.toLocaleString()} rows. Narrow your filters.`);
    const rows = await tx.lead.findMany({ where, orderBy: { createdAt: 'asc' }, select: { ...LIST_SELECT, secondaryPhone: true } });
    const names = await orgNameMap(tx, rows.map((r) => r.assignedOrganizationId));
    const header = ['id', 'full_name', 'email', 'phone', 'secondary_phone', 'company', 'job_title', 'city', 'state', 'country', 'industry', 'source', 'campaign', 'score', 'priority', 'quality', 'allocation', 'assigned_to', 'client_status', 'tags', 'created_at'];
    const body = rows.map((r) => [
      r.id, r.fullName,
      includeContacts ? r.email : maskEmail(r.email), includeContacts ? r.phone : maskPhone(r.phone), includeContacts ? r.secondaryPhone : maskPhone(r.secondaryPhone),
      r.company, r.jobTitle, r.city, r.state, r.country, r.industry, r.source, r.campaign, r.score, r.priority, r.quality, r.allocationStatus,
      r.assignedOrganizationId ? names.get(r.assignedOrganizationId) : '', r.clientStatus, r.tags.map((t) => t.tag.name).join('; '), r.createdAt,
    ]);
    await audit(tx, ctx, {
      action: 'lead.exported', targetType: 'lead', organizationId: null, reason,
      metadata: { rows: rows.length, includeContacts, filter, view },
    });
    return { csv: toCsv([header, ...body]), rows: rows.length };
  }, { timeout: 120_000 });
}
