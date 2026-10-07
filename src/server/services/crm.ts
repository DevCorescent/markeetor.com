import { Prisma, type ClientLeadStatus } from '@prisma/client';
import { z } from 'zod';
import type { Filter } from '@/lib/filters';
import { maskEmail, maskPhone, type SensitiveField } from '@/lib/mask';
import { researchOf } from '@/lib/research-score';
import { audit, diff } from '../audit';
import { can, tenantOf, type AuthContext } from '../auth/context';
import { prisma, withPlatform, withTenant, type Tx } from '../db';
import { AppError, notFound } from '../errors';
import { rateLimit } from '../ratelimit';
import { onLeadAccess } from '../security/alerts';
import { getSetting } from '../settings';
import { ACTIVITY, recordActivity } from './activity';
import { buildClientLeadWhere, CLIENT_SORTS, pickSort, type LeadView } from './lead-filters';
import { normalizeEmail, normalizePhone } from './normalize';
import { notifyUsers } from './notifications';
import { orgSettings } from './organizations';

/**
 * Client CRM service. All reads/writes run inside `withTenant(org)`, so PostgreSQL row-level security
 * confines every query to the caller's organization in addition to the explicit organizationId filters.
 * Records outside the caller's visibility return NOT_FOUND (never FORBIDDEN) to avoid IDOR enumeration.
 */

const ownOnly = (ctx: AuthContext) => (can(ctx, 'crm.leads.read_all') ? null : ctx.user.id);

/** Loads a client lead visible to the caller or throws NOT_FOUND. */
export async function visibleLead(tx: Tx, ctx: AuthContext, id: string) {
  const org = tenantOf(ctx);
  const owner = ownOnly(ctx);
  const lead = await tx.clientLead.findFirst({ where: { id, organizationId: org, revokedAt: null, ...(owner ? { ownerId: owner } : {}) } });
  if (!lead) throw notFound('Lead');
  return lead;
}

/** Keeps the platform's master record in sync with tenant-side progress (status, recency). Server-internal only. */
async function syncMaster(leadId: string, assignmentId: string, patch: { clientStatus?: ClientLeadStatus; lastActivityAt?: Date; nextFollowUpAt?: Date | null }) {
  await withPlatform(async (tx) => {
    const a = await tx.leadAssignment.findUnique({ where: { id: assignmentId }, select: { status: true, leadId: true } });
    if (!a || a.status !== 'ACTIVE' || a.leadId !== leadId) return;
    await tx.lead.update({ where: { id: leadId }, data: patch });
  });
}

const LIST_SELECT = {
  id: true, leadId: true, fullName: true, email: true, phone: true, company: true, jobTitle: true, city: true, country: true, industry: true,
  source: true, campaign: true, score: true, priority: true, status: true, ownerId: true, stageId: true, dealValue: true, currency: true,
  nextFollowUpAt: true, lastActivityAt: true, firstContactAt: true, createdAt: true, archivedAt: true,
  owner: { select: { id: true, name: true } }, stage: { select: { id: true, name: true, category: true } },
  tags: { select: { tag: { select: { id: true, name: true } } } },
} satisfies Prisma.ClientLeadSelect;

export async function listClientLeads(ctx: AuthContext, params: { filter: Filter; view: LeadView | 'unassigned'; sort?: { id: string; desc: boolean } | null; page: number; pageSize: number }) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const base = buildClientLeadWhere(org, params.filter, { ownerOnly: ownOnly(ctx), view: params.view === 'unassigned' ? 'active' : params.view });
    const where: Prisma.ClientLeadWhereInput = params.view === 'unassigned' ? { AND: [base, { ownerId: null }] } : base;
    const picked = pickSort(CLIENT_SORTS, params.sort);
    const orderBy = picked ? [picked, { id: 'asc' as const }] : [{ createdAt: 'desc' as const }, { id: 'asc' as const }];
    const [total, rows] = await Promise.all([
      tx.clientLead.count({ where }),
      tx.clientLead.findMany({ where, orderBy, skip: (params.page - 1) * params.pageSize, take: params.pageSize, select: LIST_SELECT }),
    ]);
    // Research lives on the platform's master lead; only its score and status are read.
    const research = rows.length ? await withPlatform((ptx) => ptx.leadEnrichment.findMany({ where: { leadId: { in: rows.map((r) => r.leadId) } }, select: { leadId: true, status: true, confidence: true, finishedAt: true } })) : [];
    const byLead = new Map(research.map((e) => [e.leadId, researchOf(e)]));
    return {
      total,
      rows: rows.map((r) => ({ ...r, email: maskEmail(r.email), phone: maskPhone(r.phone), dealValue: r.dealValue ? Number(r.dealValue) : null, tags: r.tags.map((t) => t.tag), research: byLead.get(r.leadId) ?? null })),
    };
  });
}

export async function clientFacets(ctx: AuthContext) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const distinct = async (field: 'source' | 'campaign' | 'industry' | 'country') => {
      const rows = await tx.clientLead.groupBy({ by: [field], where: { organizationId: org, revokedAt: null, [field]: { not: null } }, _count: true, orderBy: { _count: { [field]: 'desc' } }, take: 100 });
      return rows.map((r) => r[field] as string);
    };
    const [sources, campaigns, industries, countries, tags, members, stages, fields] = await Promise.all([
      distinct('source'), distinct('campaign'), distinct('industry'), distinct('country'),
      tx.tag.findMany({ where: { organizationId: org }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      tx.membership.findMany({ where: { organizationId: org, user: { status: 'ACTIVE' } }, select: { user: { select: { id: true, name: true } }, role: { select: { name: true } } } }),
      tx.pipelineStage.findMany({ where: { organizationId: org, pipeline: { isDefault: true } }, orderBy: { position: 'asc' }, select: { id: true, name: true, category: true, probability: true } }),
      tx.customFieldDefinition.findMany({ where: { organizationId: org }, orderBy: { position: 'asc' } }),
    ]);
    return { sources, campaigns, industries, countries, tags, members: members.map((m) => ({ id: m.user.id, name: m.user.name, role: m.role.name })), stages, fields };
  });
}

export async function getClientLead(ctx: AuthContext, id: string) {
  const org = tenantOf(ctx);
  const data = await withTenant(org, async (tx) => {
    const lead = await visibleLead(tx, ctx, id);
    const [owner, stage, tags, notes, tasks, comms, attachments, activities, consents, history, dupes, fields] = await Promise.all([
      lead.ownerId ? tx.user.findUnique({ where: { id: lead.ownerId }, select: { id: true, name: true } }) : null,
      lead.stageId ? tx.pipelineStage.findUnique({ where: { id: lead.stageId } }) : null,
      tx.clientLeadTag.findMany({ where: { clientLeadId: id }, include: { tag: { select: { id: true, name: true } } } }),
      tx.note.findMany({ where: { clientLeadId: id, deletedAt: null }, orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }], take: 100 }),
      tx.task.findMany({ where: { clientLeadId: id }, orderBy: [{ status: 'asc' }, { dueAt: 'asc' }], take: 100 }),
      tx.communicationLog.findMany({ where: { clientLeadId: id }, orderBy: { occurredAt: 'desc' }, take: 100 }),
      tx.attachment.findMany({ where: { clientLeadId: id, deletedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, fileName: true, mimeType: true, size: true, createdAt: true, uploadedById: true } }),
      tx.activity.findMany({ where: { clientLeadId: id }, orderBy: { createdAt: 'desc' }, take: 150 }),
      tx.consentRecord.findMany({ where: { clientLeadId: id }, orderBy: { createdAt: 'desc' } }),
      tx.stageHistory.findMany({ where: { clientLeadId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      tx.clientLead.findMany({
        where: {
          organizationId: org, revokedAt: null, id: { not: id },
          OR: [...(lead.email ? [{ email: { equals: lead.email, mode: 'insensitive' as const } }] : []), ...(lead.phone ? [{ phone: lead.phone }] : [])],
        },
        select: { id: true, fullName: true, company: true, status: true }, take: 5,
      }),
      tx.customFieldDefinition.findMany({ where: { organizationId: org }, orderBy: { position: 'asc' } }),
    ]);
    // Activity entries for this lead from before allocation (e.g. other tenants, imports) are never visible here: they carry no clientLeadId.
    const assignment = await tx.activity.findFirst({ where: { clientLeadId: null, organizationId: org, leadId: lead.leadId, type: ACTIVITY.LEAD_ASSIGNED }, orderBy: { createdAt: 'desc' } });
    const peopleIds = [...new Set([...notes.map((n) => n.authorId), ...tasks.map((t) => t.assigneeId), ...comms.map((c) => c.userId), ...activities.map((a) => a.actorId), ...attachments.map((a) => a.uploadedById), ...history.map((h) => h.changedById)].filter(Boolean) as string[])];
    const people = await tx.user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, name: true } });
    const stageIds = [...new Set(history.flatMap((h) => [h.fromStageId, h.toStageId]).filter(Boolean) as string[])];
    const stageNames = await tx.pipelineStage.findMany({ where: { id: { in: stageIds } }, select: { id: true, name: true } });
    await recordActivity(tx, { organizationId: org, clientLeadId: id, leadId: lead.leadId, actorId: ctx.user.id, type: ACTIVITY.LEAD_VIEWED, summary: 'Viewed' });
    return { lead, owner, stage, tags, notes, tasks, comms, attachments, activities, consents, history, dupes, fields, assignment, people: new Map(people.map((p) => [p.id, p.name])), stageNames: new Map(stageNames.map((s) => [s.id, s.name])) };
  });
  await onLeadAccess(ctx.user.id, org, ctx.ip, 'view');
  const name = (id: string | null) => (id ? (data.people.get(id) ?? 'Former member') : 'System');
  const latestConsent: Record<string, string> = {};
  for (const c of data.consents) if (!latestConsent[c.channel]) latestConsent[c.channel] = c.status;
  const { lead } = data;
  return {
    lead: {
      ...lead,
      email: maskEmail(lead.email), phone: maskPhone(lead.phone), secondaryPhone: maskPhone(lead.secondaryPhone),
      hasEmail: Boolean(lead.email), hasPhone: Boolean(lead.phone), hasSecondaryPhone: Boolean(lead.secondaryPhone),
      dealValue: lead.dealValue ? Number(lead.dealValue) : null,
    },
    owner: data.owner,
    stage: data.stage,
    tags: data.tags.map((t) => t.tag),
    notes: data.notes.map((n) => ({ ...n, authorName: name(n.authorId), mine: n.authorId === ctx.user.id })),
    tasks: data.tasks.map((t) => ({ ...t, assigneeName: t.assigneeId ? name(t.assigneeId) : null })),
    comms: data.comms.map((c) => ({ ...c, userName: name(c.userId) })),
    attachments: data.attachments.map((a) => ({ ...a, uploadedBy: name(a.uploadedById) })),
    activities: [...data.activities, ...(data.assignment ? [data.assignment] : [])].map((a) => ({ ...a, actorName: name(a.actorId) })),
    consent: latestConsent,
    consents: data.consents.map((c) => ({ ...c, recordedBy: name(c.recordedById) })),
    stageHistory: data.history.map((h) => ({ ...h, durationMs: h.durationMs ? Number(h.durationMs) : null, from: h.fromStageId ? (data.stageNames.get(h.fromStageId) ?? '—') : null, to: data.stageNames.get(h.toStageId) ?? '—', by: name(h.changedById) })),
    duplicates: data.dupes,
    fields: data.fields,
  };
}

export async function revealClientField(ctx: AuthContext, id: string, field: SensitiveField, reason?: string) {
  const org = tenantOf(ctx);
  const settings = orgSettings(ctx.org?.settings);
  if (settings.security.revealRequiresReason && (!reason || reason.trim().length < 3)) throw new AppError('VALIDATION_FAILED', 'Your workspace requires a reason to reveal contact details');
  const policy = await getSetting('security.policy');
  const lim = await rateLimit(`reveal:${ctx.user.id}`, policy.revealsPerHour, 3600);
  const orgLim = await rateLimit(`reveal-org:${org}`, policy.revealsPerHour * 20, 3600);
  if (!lim.ok || !orgLim.ok) throw new AppError('RATE_LIMITED', 'Reveal limit reached for this hour. This has been logged.');
  const value = await withTenant(org, async (tx) => {
    const lead = await visibleLead(tx, ctx, id);
    await recordActivity(tx, { organizationId: org, clientLeadId: id, leadId: lead.leadId, actorId: ctx.user.id, type: ACTIVITY.FIELD_REVEALED, summary: `Revealed ${field}`, data: { field } });
    await audit(tx, ctx, { action: 'crm.lead.field.revealed', targetType: 'client_lead', targetId: id, reason: reason ?? null, metadata: { field } });
    return lead[field];
  });
  await onLeadAccess(ctx.user.id, org, ctx.ip, 'reveal');
  return { field, value };
}

// ── Updates ────────────────────────────────────────────────────────

export const clientLeadEdit = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    email: z.string().trim().max(254).nullable(),
    phone: z.string().trim().max(40).nullable(),
    secondaryPhone: z.string().trim().max(40).nullable(),
    company: z.string().trim().max(200).nullable(),
    jobTitle: z.string().trim().max(120).nullable(),
    city: z.string().trim().max(80).nullable(),
    state: z.string().trim().max(80).nullable(),
    country: z.string().trim().max(80).nullable(),
    industry: z.string().trim().max(80).nullable(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
    nextFollowUpAt: z.coerce.date().nullable(),
    dealValue: z.number().min(0).max(1e12).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    expectedCloseDate: z.coerce.date().nullable(),
    probability: z.number().int().min(0).max(100).nullable(),
    customFields: z.record(z.string().max(60), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])),
  })
  .partial()
  // Attribution (source, campaign) and distribution history are deliberately absent: clients cannot change them.
  .strict();

export async function updateClientLead(ctx: AuthContext, id: string, input: z.infer<typeof clientLeadEdit>) {
  const org = tenantOf(ctx);
  const { defaultCountry } = await getSetting('imports.policy');
  const result = await withTenant(org, async (tx) => {
    const lead = await visibleLead(tx, ctx, id);
    const data: Prisma.ClientLeadUpdateInput = {};
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (k === 'email') {
        if (v && normalizeEmail(v).error) throw new AppError('VALIDATION_FAILED', 'Invalid email address');
        data.email = v ? String(v) : null;
      } else if (k === 'phone' || k === 'secondaryPhone') {
        if (v && normalizePhone(v, defaultCountry).error) throw new AppError('VALIDATION_FAILED', 'Invalid phone number');
        (data as Record<string, unknown>)[k] = v ? normalizePhone(v, defaultCountry).value : null;
      } else if (k === 'customFields') {
        const defs = await tx.customFieldDefinition.findMany({ where: { organizationId: org } });
        const out: Record<string, unknown> = { ...(lead.customFields as object) };
        for (const [fk, fv] of Object.entries(v as Record<string, unknown>)) {
          const def = defs.find((d) => d.key === fk);
          if (!def) throw new AppError('VALIDATION_FAILED', `Unknown custom field: ${fk}`);
          if (fv === null || fv === '') { out[fk] = null; continue; }
          if (def.type === 'NUMBER' && typeof fv !== 'number') throw new AppError('VALIDATION_FAILED', `${def.label} must be a number`);
          if (def.type === 'BOOLEAN' && typeof fv !== 'boolean') throw new AppError('VALIDATION_FAILED', `${def.label} must be yes/no`);
          if (def.type === 'SELECT' && !def.options.includes(String(fv))) throw new AppError('VALIDATION_FAILED', `${def.label} has an invalid option`);
          if (def.type === 'DATE' && Number.isNaN(new Date(String(fv)).getTime())) throw new AppError('VALIDATION_FAILED', `${def.label} must be a date`);
          out[fk] = fv;
        }
        for (const d of defs) if (d.required && (out[d.key] == null || out[d.key] === '')) throw new AppError('VALIDATION_FAILED', `${d.label} is required`);
        data.customFields = out as Prisma.InputJsonValue;
      } else {
        (data as Record<string, unknown>)[k] = v;
      }
    }
    if (data.dealValue !== undefined) data.dealValue = data.dealValue === null ? null : new Prisma.Decimal(data.dealValue as number);
    const d = diff(lead as unknown as Record<string, unknown>, data as Record<string, unknown>);
    if (!d.changed.length) return { lead, changed: [] as string[] };
    data.lastActivityAt = new Date();
    const updated = await tx.clientLead.update({ where: { id }, data });
    const sensitive = new Set(['email', 'phone', 'secondaryPhone']);
    await recordActivity(tx, { organizationId: org, clientLeadId: id, leadId: lead.leadId, actorId: ctx.user.id, type: ACTIVITY.LEAD_EDITED, summary: `Updated ${d.changed.join(', ')}` });
    await audit(tx, ctx, {
      action: 'crm.lead.updated', targetType: 'client_lead', targetId: id,
      before: Object.fromEntries(Object.entries(d.before).filter(([k]) => !sensitive.has(k))),
      after: Object.fromEntries(Object.entries(d.after).filter(([k]) => !sensitive.has(k))),
      metadata: { changed: d.changed },
    });
    if ('nextFollowUpAt' in input && input.nextFollowUpAt) {
      await recordActivity(tx, { organizationId: org, clientLeadId: id, leadId: lead.leadId, actorId: ctx.user.id, type: ACTIVITY.FOLLOW_UP_SCHEDULED, summary: `Follow-up scheduled for ${input.nextFollowUpAt.toISOString().slice(0, 16).replace('T', ' ')}` });
      await tx.task.create({
        data: { organizationId: org, clientLeadId: id, title: `Follow up with ${updated.fullName}`, type: 'FOLLOW_UP', dueAt: input.nextFollowUpAt, assigneeId: updated.ownerId ?? ctx.user.id, createdById: ctx.user.id, priority: updated.priority },
      });
    }
    return { lead: updated, changed: d.changed };
  });
  if (result.changed.length) await syncMaster(result.lead.leadId, result.lead.assignmentId, { lastActivityAt: new Date(), ...('nextFollowUpAt' in input ? { nextFollowUpAt: input.nextFollowUpAt ?? null } : {}) });
  return result.lead;
}

export async function setClientStatus(ctx: AuthContext, id: string, status: ClientLeadStatus, lostReason?: string | null) {
  const org = tenantOf(ctx);
  if (status === 'LOST' && !lostReason?.trim()) throw new AppError('VALIDATION_FAILED', 'Select a reason for marking this lead as lost');
  const res = await withTenant(org, async (tx) => {
    const lead = await visibleLead(tx, ctx, id);
    if (lead.status === status) return lead;
    const now = new Date();
    const data: Prisma.ClientLeadUpdateInput = { status, lastActivityAt: now, lostReason: status === 'LOST' ? lostReason!.trim().slice(0, 300) : lead.lostReason };
    if (status === 'CONVERTED') data.convertedAt = now;
    if (status === 'LOST') data.lostAt = now;
    if (status !== 'CONVERTED' && lead.convertedAt) data.convertedAt = null;
    if (status !== 'LOST' && lead.lostAt) data.lostAt = null;
    // Keep the pipeline consistent with terminal statuses.
    if (status === 'CONVERTED' || status === 'LOST') {
      const target = await tx.pipelineStage.findFirst({ where: { organizationId: org, pipeline: { isDefault: true }, category: status === 'CONVERTED' ? 'WON' : 'LOST' } });
      if (target && target.id !== lead.stageId) {
        await tx.stageHistory.create({ data: { organizationId: org, clientLeadId: id, fromStageId: lead.stageId, toStageId: target.id, changedById: ctx.user.id, durationMs: lead.stageEnteredAt ? BigInt(now.getTime() - lead.stageEnteredAt.getTime()) : null } });
        data.stage = { connect: { id: target.id } };
        data.stageEnteredAt = now;
      }
    }
    const updated = await tx.clientLead.update({ where: { id }, data });
    const type = status === 'CONVERTED' ? ACTIVITY.LEAD_CONVERTED : status === 'LOST' ? ACTIVITY.LEAD_LOST : ACTIVITY.STATUS_CHANGED;
    await recordActivity(tx, { organizationId: org, clientLeadId: id, leadId: lead.leadId, actorId: ctx.user.id, type, summary: `Status ${lead.status.toLowerCase()} → ${status.toLowerCase()}${status === 'LOST' ? ` (${lostReason})` : ''}` });
    await audit(tx, ctx, { action: 'crm.lead.status_changed', targetType: 'client_lead', targetId: id, before: { status: lead.status }, after: { status, lostReason: status === 'LOST' ? lostReason : undefined } });
    return updated;
  });
  await syncMaster(res.leadId, res.assignmentId, { clientStatus: res.status, lastActivityAt: new Date() });
  const { emitWebhook } = await import('./workspace-automation');
  await emitWebhook(org, 'lead.status_changed', { id: res.id, fullName: res.fullName, company: res.company, status: res.status, dealValue: res.dealValue == null ? null : Number(res.dealValue), lostReason: res.lostReason }).catch(() => null);
  return res;
}

export async function moveStage(ctx: AuthContext, id: string, stageId: string, opts: { lostReason?: string | null } = {}) {
  const org = tenantOf(ctx);
  const res = await withTenant(org, async (tx) => {
    const lead = await visibleLead(tx, ctx, id);
    const stage = await tx.pipelineStage.findFirst({ where: { id: stageId, organizationId: org } });
    if (!stage) throw notFound('Stage');
    if (stage.id === lead.stageId) return lead;
    if (stage.requiresApproval && !can(ctx, 'crm.pipeline.manage')) throw new AppError('FORBIDDEN', `Moving a deal to “${stage.name}” requires manager approval`);
    if (stage.category === 'LOST' && !opts.lostReason?.trim()) throw new AppError('VALIDATION_FAILED', 'Select a reason for marking this deal as lost');
    const now = new Date();
    await tx.stageHistory.create({ data: { organizationId: org, clientLeadId: id, fromStageId: lead.stageId, toStageId: stage.id, changedById: ctx.user.id, durationMs: lead.stageEnteredAt ? BigInt(now.getTime() - lead.stageEnteredAt.getTime()) : null } });
    let status: ClientLeadStatus = lead.status;
    if (stage.category === 'WON') status = 'CONVERTED';
    else if (stage.category === 'LOST') status = 'LOST';
    else if (lead.status === 'CONVERTED' || lead.status === 'LOST') status = 'QUALIFIED';
    const updated = await tx.clientLead.update({
      where: { id },
      data: {
        stageId: stage.id, stageEnteredAt: now, lastActivityAt: now, status, probability: stage.probability,
        convertedAt: status === 'CONVERTED' ? now : null, lostAt: status === 'LOST' ? now : null,
        lostReason: status === 'LOST' ? opts.lostReason!.trim().slice(0, 300) : lead.lostReason,
      },
    });
    await recordActivity(tx, { organizationId: org, clientLeadId: id, leadId: lead.leadId, actorId: ctx.user.id, type: status === 'CONVERTED' ? ACTIVITY.LEAD_CONVERTED : status === 'LOST' ? ACTIVITY.LEAD_LOST : ACTIVITY.STAGE_CHANGED, summary: `Moved to ${stage.name}` });
    await audit(tx, ctx, { action: 'crm.lead.stage_changed', targetType: 'client_lead', targetId: id, before: { stageId: lead.stageId, status: lead.status }, after: { stageId: stage.id, status } });
    return updated;
  });
  await syncMaster(res.leadId, res.assignmentId, { clientStatus: res.status, lastActivityAt: new Date() });
  return res;
}

async function assertMember(tx: Tx, org: string, userId: string) {
  const m = await tx.membership.findFirst({ where: { organizationId: org, userId, user: { status: 'ACTIVE' } } });
  if (!m) throw new AppError('VALIDATION_FAILED', 'That user is not an active member of this workspace');
}

export async function assignOwner(ctx: AuthContext, ids: string[], ownerId: string | null) {
  const org = tenantOf(ctx);
  if (ids.length > 1000) throw new AppError('VALIDATION_FAILED', 'Assign at most 1,000 leads at a time');
  return withTenant(org, async (tx) => {
    if (ownerId) await assertMember(tx, org, ownerId);
    const leads = await tx.clientLead.findMany({ where: { id: { in: ids }, organizationId: org, revokedAt: null }, select: { id: true, leadId: true, ownerId: true, fullName: true } });
    if (!leads.length) throw notFound('Lead');
    const changing = leads.filter((l) => l.ownerId !== ownerId);
    await tx.clientLead.updateMany({ where: { id: { in: changing.map((l) => l.id) } }, data: { ownerId, lastActivityAt: new Date() } });
    const ownerName = ownerId ? (await tx.user.findUnique({ where: { id: ownerId }, select: { name: true } }))?.name : null;
    await tx.activity.createMany({ data: changing.map((l) => ({ organizationId: org, clientLeadId: l.id, leadId: l.leadId, actorId: ctx.user.id, type: ACTIVITY.OWNER_CHANGED, summary: ownerId ? `Assigned to ${ownerName}` : 'Unassigned', data: { from: l.ownerId, to: ownerId } })) });
    await audit(tx, ctx, { action: 'crm.lead.owner_changed', targetType: 'client_lead', targetId: changing.length === 1 ? changing[0].id : null, after: { ownerId, count: changing.length } });
    if (ownerId && ownerId !== ctx.user.id && changing.length) {
      await notifyUsers([ownerId], { type: 'LEAD_ASSIGNED', title: changing.length === 1 ? `You were assigned ${changing[0].fullName}` : `You were assigned ${changing.length} leads`, link: changing.length === 1 ? `/app/leads/${changing[0].id}` : '/app/leads', organizationId: org }, tx);
    }
    return { updated: changing.length };
  });
}

export async function bulkSetStatus(ctx: AuthContext, ids: string[], status: ClientLeadStatus, lostReason?: string) {
  if (ids.length > 500) throw new AppError('VALIDATION_FAILED', 'Update at most 500 leads at a time');
  let updated = 0;
  for (const id of ids) {
    try {
      await setClientStatus(ctx, id, status, lostReason);
      updated++;
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'NOT_FOUND')) throw e;
    }
  }
  return { updated };
}

export async function archiveClientLeads(ctx: AuthContext, ids: string[], archive: boolean) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const owner = ownOnly(ctx);
    const res = await tx.clientLead.updateMany({ where: { id: { in: ids }, organizationId: org, revokedAt: null, ...(owner ? { ownerId: owner } : {}) }, data: { archivedAt: archive ? new Date() : null } });
    const leads = await tx.clientLead.findMany({ where: { id: { in: ids } }, select: { id: true, leadId: true } });
    await tx.activity.createMany({ data: leads.map((l) => ({ organizationId: org, clientLeadId: l.id, leadId: l.leadId, actorId: ctx.user.id, type: archive ? ACTIVITY.LEAD_ARCHIVED : ACTIVITY.LEAD_RESTORED, summary: archive ? 'Archived' : 'Restored' })) });
    await audit(tx, ctx, { action: archive ? 'crm.lead.archived' : 'crm.lead.restored', targetType: 'client_lead', targetId: ids.length === 1 ? ids[0] : null, metadata: { count: res.count } });
    return { updated: res.count };
  });
}

export async function tagClientLeads(ctx: AuthContext, ids: string[], add: string[], remove: string[]) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const leads = await tx.clientLead.findMany({ where: { id: { in: ids }, organizationId: org, revokedAt: null }, select: { id: true } });
    const tagIds: string[] = [];
    for (const name of [...new Set(add.map((a) => a.trim()).filter(Boolean))]) {
      const t = (await tx.tag.findFirst({ where: { organizationId: org, name } })) ?? (await tx.tag.create({ data: { organizationId: org, name } }));
      tagIds.push(t.id);
    }
    if (tagIds.length) await tx.clientLeadTag.createMany({ data: leads.flatMap((l) => tagIds.map((tagId) => ({ clientLeadId: l.id, tagId, organizationId: org }))), skipDuplicates: true });
    if (remove.length) await tx.clientLeadTag.deleteMany({ where: { clientLeadId: { in: leads.map((l) => l.id) }, tagId: { in: remove } } });
    await audit(tx, ctx, { action: 'crm.lead.tagged', targetType: 'client_lead', metadata: { count: leads.length, add, remove } });
    return { updated: leads.length };
  });
}

/** Merges duplicate projections inside one workspace: notes, tasks, communication, attachments and tags move to the primary. */
export async function mergeClientLeads(ctx: AuthContext, primaryId: string, duplicateId: string) {
  const org = tenantOf(ctx);
  if (primaryId === duplicateId) throw new AppError('VALIDATION_FAILED', 'Choose two different leads');
  return withTenant(org, async (tx) => {
    const primary = await visibleLead(tx, ctx, primaryId);
    const dup = await visibleLead(tx, ctx, duplicateId);
    for (const model of ['note', 'task', 'communicationLog', 'attachment', 'consentRecord'] as const) {
      await (tx[model] as unknown as { updateMany: (a: unknown) => Promise<unknown> }).updateMany({ where: { clientLeadId: dup.id }, data: { clientLeadId: primary.id } });
    }
    const tags = await tx.clientLeadTag.findMany({ where: { clientLeadId: dup.id } });
    await tx.clientLeadTag.createMany({ data: tags.map((t) => ({ clientLeadId: primary.id, tagId: t.tagId, organizationId: org })), skipDuplicates: true });
    const fill: Record<string, unknown> = {};
    for (const f of ['email', 'phone', 'secondaryPhone', 'company', 'jobTitle', 'city', 'state', 'country', 'industry'] as const) if (!primary[f] && dup[f]) fill[f] = dup[f];
    await tx.clientLead.update({ where: { id: primary.id }, data: { ...fill, lastActivityAt: new Date() } });
    await tx.clientLead.update({ where: { id: dup.id }, data: { archivedAt: new Date(), lostReason: `Merged into ${primary.fullName}` } });
    await recordActivity(tx, { organizationId: org, clientLeadId: primary.id, leadId: primary.leadId, actorId: ctx.user.id, type: ACTIVITY.LEAD_MERGED, summary: `Merged duplicate ${dup.fullName}`, data: { duplicateId: dup.id } });
    await recordActivity(tx, { organizationId: org, clientLeadId: dup.id, leadId: dup.leadId, actorId: ctx.user.id, type: ACTIVITY.LEAD_MERGED, summary: `Merged into ${primary.fullName}`, data: { primaryId: primary.id } });
    await audit(tx, ctx, { action: 'crm.lead.merged', targetType: 'client_lead', targetId: primary.id, metadata: { duplicateId: dup.id, filled: Object.keys(fill) } });
    return { ok: true };
  });
}

// ── Notes, communication, consent ──────────────────────────────────

export async function addNote(ctx: AuthContext, id: string, body: string, pinned = false) {
  const org = tenantOf(ctx);
  const res = await withTenant(org, async (tx) => {
    const lead = await visibleLead(tx, ctx, id);
    const note = await tx.note.create({ data: { organizationId: org, clientLeadId: id, authorId: ctx.user.id, body: body.trim(), pinned } });
    await tx.clientLead.update({ where: { id }, data: { lastActivityAt: new Date() } });
    await recordActivity(tx, { organizationId: org, clientLeadId: id, leadId: lead.leadId, actorId: ctx.user.id, type: ACTIVITY.NOTE_ADDED, verification: 'SELF_REPORTED', summary: 'Added a note' });
    return { note, lead };
  });
  await syncMaster(res.lead.leadId, res.lead.assignmentId, { lastActivityAt: new Date() });
  return res.note;
}

export async function deleteNote(ctx: AuthContext, noteId: string) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const note = await tx.note.findFirst({ where: { id: noteId, organizationId: org, deletedAt: null } });
    if (!note) throw notFound('Note');
    await visibleLead(tx, ctx, note.clientLeadId);
    if (note.authorId !== ctx.user.id) throw new AppError('FORBIDDEN', 'You can only delete your own notes');
    await tx.note.update({ where: { id: noteId }, data: { deletedAt: new Date() } });
    await audit(tx, ctx, { action: 'crm.note.deleted', targetType: 'note', targetId: noteId, before: { body: note.body.slice(0, 500) } });
  });
}

export const commInput = z.object({
  channel: z.enum(['CALL', 'EMAIL', 'SMS', 'WHATSAPP', 'MEETING']),
  direction: z.enum(['OUTBOUND', 'INBOUND']).default('OUTBOUND'),
  outcome: z.enum(['CONNECTED', 'NO_ANSWER', 'VOICEMAIL', 'BUSY', 'WRONG_NUMBER', 'SENT', 'REPLIED', 'BOUNCED', 'HELD', 'NO_SHOW', 'RESCHEDULED']),
  durationSec: z.number().int().min(0).max(86_400).nullable().optional(),
  subject: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().max(5000).nullable().optional(),
  occurredAt: z.coerce.date().optional(),
});

const POSITIVE = new Set(['CONNECTED', 'REPLIED', 'HELD']);

/** Logs a contact attempt. Recorded as SELF_REPORTED — a log entry is not proof that a conversation happened. */
export async function logCommunication(ctx: AuthContext, id: string, input: z.infer<typeof commInput>) {
  const org = tenantOf(ctx);
  const occurredAt = input.occurredAt ?? new Date();
  if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw new AppError('VALIDATION_FAILED', 'Contact attempts cannot be logged in the future');
  const res = await withTenant(org, async (tx) => {
    const lead = await visibleLead(tx, ctx, id);
    if (occurredAt < lead.createdAt) throw new AppError('VALIDATION_FAILED', 'Contact attempts cannot predate the allocation of this lead');
    if (input.direction === 'OUTBOUND' && input.channel !== 'MEETING') {
      const consent = await tx.consentRecord.findFirst({ where: { clientLeadId: id, channel: input.channel }, orderBy: { createdAt: 'desc' } });
      if (consent?.status === 'OPTED_OUT') throw new AppError('CONFLICT', `This lead has opted out of ${input.channel.toLowerCase()} contact`);
    }
    const log = await tx.communicationLog.create({ data: { organizationId: org, clientLeadId: id, userId: ctx.user.id, ...input, occurredAt, verification: 'SELF_REPORTED' } });
    const data: Prisma.ClientLeadUpdateInput = { lastActivityAt: new Date() };
    if (!lead.firstContactAt && input.direction === 'OUTBOUND') data.firstContactAt = occurredAt;
    if (lead.status === 'NEW' && (POSITIVE.has(input.outcome) || input.direction === 'INBOUND')) data.status = 'CONTACTED';
    const updated = await tx.clientLead.update({ where: { id }, data });
    await recordActivity(tx, {
      organizationId: org, clientLeadId: id, leadId: lead.leadId, actorId: ctx.user.id, type: ACTIVITY.CONTACT_LOGGED, verification: 'SELF_REPORTED',
      summary: `${input.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} ${input.channel.toLowerCase()} — ${input.outcome.replace(/_/g, ' ').toLowerCase()}`,
      data: { logId: log.id },
    });
    return { log, updated };
  });
  await syncMaster(res.updated.leadId, res.updated.assignmentId, { lastActivityAt: new Date(), clientStatus: res.updated.status });
  return res.log;
}

export async function recordConsent(ctx: AuthContext, id: string, input: { channel: 'CALL' | 'EMAIL' | 'SMS' | 'WHATSAPP' | 'MEETING'; status: 'OPTED_IN' | 'OPTED_OUT'; source?: string | null; note?: string | null }) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const lead = await visibleLead(tx, ctx, id);
    const rec = await tx.consentRecord.create({ data: { organizationId: org, clientLeadId: id, channel: input.channel, status: input.status, source: input.source ?? null, note: input.note ?? null, recordedById: ctx.user.id } });
    await recordActivity(tx, { organizationId: org, clientLeadId: id, leadId: lead.leadId, actorId: ctx.user.id, type: ACTIVITY.CONSENT_CHANGED, verification: 'SELF_REPORTED', summary: `${input.channel.toLowerCase()} consent: ${input.status === 'OPTED_IN' ? 'opted in' : 'opted out'}` });
    await audit(tx, ctx, { action: 'crm.consent.recorded', targetType: 'client_lead', targetId: id, after: { channel: input.channel, status: input.status, source: input.source } });
    return rec;
  });
}

// ── Tasks ──────────────────────────────────────────────────────────

export const taskInput = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  type: z.enum(['TODO', 'CALL', 'MEETING', 'EMAIL', 'FOLLOW_UP']).default('TODO'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  dueAt: z.coerce.date().nullable().optional(),
  reminderAt: z.coerce.date().nullable().optional(),
  assigneeId: z.string().max(64).nullable().optional(),
  clientLeadId: z.string().max(64).nullable().optional(),
  recurrence: z.enum(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY']).default('NONE'),
});

export async function createTask(ctx: AuthContext, input: z.infer<typeof taskInput>) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    let leadId: string | null = null;
    if (input.clientLeadId) leadId = (await visibleLead(tx, ctx, input.clientLeadId)).leadId;
    const assigneeId = input.assigneeId ?? ctx.user.id;
    if (assigneeId !== ctx.user.id) {
      if (!can(ctx, 'crm.tasks.read_all') && !can(ctx, 'crm.team.manage')) throw new AppError('FORBIDDEN', 'You can only create tasks for yourself');
      await assertMember(tx, org, assigneeId);
    }
    const task = await tx.task.create({ data: { ...input, organizationId: org, assigneeId, createdById: ctx.user.id, delegatedById: assigneeId !== ctx.user.id ? ctx.user.id : null } });
    if (input.clientLeadId) {
      await recordActivity(tx, { organizationId: org, clientLeadId: input.clientLeadId, leadId, actorId: ctx.user.id, type: ACTIVITY.TASK_CREATED, summary: `Task: ${input.title}` });
    }
    if (assigneeId !== ctx.user.id) {
      await notifyUsers([assigneeId], { type: 'TASK_ASSIGNED', title: `New task from ${ctx.user.name}: ${input.title}`, link: '/app/tasks', organizationId: org }, tx);
    }
    return task;
  });
}

async function visibleTask(tx: Tx, ctx: AuthContext, taskId: string) {
  const org = tenantOf(ctx);
  const task = await tx.task.findFirst({ where: { id: taskId, organizationId: org } });
  if (!task) throw notFound('Task');
  if (!can(ctx, 'crm.tasks.read_all') && task.assigneeId !== ctx.user.id && task.createdById !== ctx.user.id) throw notFound('Task');
  return task;
}

export const taskUpdate = taskInput.partial().extend({ status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(), completionNote: z.string().trim().max(2000).nullable().optional() });

const nextOccurrence = (d: Date, r: string) => {
  const n = new Date(d);
  if (r === 'DAILY') n.setDate(n.getDate() + 1);
  if (r === 'WEEKLY') n.setDate(n.getDate() + 7);
  if (r === 'MONTHLY') n.setMonth(n.getMonth() + 1);
  return n;
};

export async function updateTask(ctx: AuthContext, taskId: string, input: z.infer<typeof taskUpdate>) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const task = await visibleTask(tx, ctx, taskId);
    if (input.assigneeId && input.assigneeId !== task.assigneeId) {
      await assertMember(tx, org, input.assigneeId);
      if (input.assigneeId !== ctx.user.id && !can(ctx, 'crm.tasks.read_all') && !can(ctx, 'crm.team.manage')) throw new AppError('FORBIDDEN', 'You cannot delegate tasks');
    }
    if (input.clientLeadId && input.clientLeadId !== task.clientLeadId) await visibleLead(tx, ctx, input.clientLeadId);
    const completing = input.status === 'DONE' && task.status !== 'DONE';
    const updated = await tx.task.update({
      where: { id: taskId },
      data: {
        ...input,
        ...(completing ? { completedAt: new Date(), completedById: ctx.user.id } : {}),
        ...(input.status && input.status !== 'DONE' ? { completedAt: null, completedById: null } : {}),
        ...(input.assigneeId && input.assigneeId !== task.assigneeId ? { delegatedById: ctx.user.id } : {}),
      },
    });
    if (completing) {
      if (task.clientLeadId) {
        const cl = await tx.clientLead.update({ where: { id: task.clientLeadId }, data: { lastActivityAt: new Date() } });
        await recordActivity(tx, { organizationId: org, clientLeadId: task.clientLeadId, leadId: cl.leadId, actorId: ctx.user.id, type: ACTIVITY.TASK_COMPLETED, verification: 'SELF_REPORTED', summary: `Completed: ${task.title}`, data: { note: input.completionNote ?? null } });
      }
      if (task.recurrence !== 'NONE' && task.dueAt) {
        await tx.task.create({
          data: {
            organizationId: org, clientLeadId: task.clientLeadId, title: task.title, description: task.description, type: task.type, priority: task.priority,
            dueAt: nextOccurrence(task.dueAt, task.recurrence), assigneeId: task.assigneeId, createdById: task.createdById, recurrence: task.recurrence, parentTaskId: task.parentTaskId ?? task.id,
          },
        });
      }
    }
    if (input.assigneeId && input.assigneeId !== task.assigneeId && input.assigneeId !== ctx.user.id) {
      await notifyUsers([input.assigneeId], { type: 'TASK_ASSIGNED', title: `Task delegated to you: ${updated.title}`, link: '/app/tasks', organizationId: org }, tx);
    }
    return updated;
  });
}

export async function deleteTask(ctx: AuthContext, taskId: string) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const task = await visibleTask(tx, ctx, taskId);
    if (task.createdById !== ctx.user.id && !can(ctx, 'crm.team.manage')) throw new AppError('FORBIDDEN', 'Only the creator or a manager can delete this task');
    await tx.task.delete({ where: { id: taskId } });
    await audit(tx, ctx, { action: 'crm.task.deleted', targetType: 'task', targetId: taskId, before: { title: task.title } });
  });
}

export async function listTasks(ctx: AuthContext, params: { scope: 'mine' | 'team' | 'delegated'; status?: 'open' | 'done' | 'overdue' | 'all'; from?: Date; to?: Date; assigneeId?: string; page: number; pageSize: number }) {
  const org = tenantOf(ctx);
  if (params.scope === 'team' && !can(ctx, 'crm.tasks.read_all')) throw new AppError('FORBIDDEN', 'You cannot view team tasks');
  return withTenant(org, async (tx) => {
    const where: Prisma.TaskWhereInput = {
      organizationId: org,
      ...(params.scope === 'mine' ? { assigneeId: ctx.user.id } : params.scope === 'delegated' ? { delegatedById: ctx.user.id, NOT: { assigneeId: ctx.user.id } } : params.assigneeId ? { assigneeId: params.assigneeId } : {}),
      ...(params.status === 'open' ? { status: { in: ['OPEN', 'IN_PROGRESS'] } } : params.status === 'done' ? { status: 'DONE' } : params.status === 'overdue' ? { status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { lt: new Date() } } : {}),
      ...(params.from || params.to ? { dueAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } } : {}),
    };
    const [total, rows] = await Promise.all([
      tx.task.count({ where }),
      tx.task.findMany({
        where, orderBy: [{ status: 'asc' }, { dueAt: { sort: 'asc', nulls: 'last' } }], skip: (params.page - 1) * params.pageSize, take: params.pageSize,
        include: { assignee: { select: { id: true, name: true } }, clientLead: { select: { id: true, fullName: true } } },
      }),
    ]);
    return { total, rows };
  });
}

// ── Team, targets, ownership transfer ───────────────────────────────

export async function teamOverview(ctx: AuthContext) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const [members, teams, invitations, targets] = await Promise.all([
      tx.membership.findMany({
        where: { organizationId: org },
        include: { user: { select: { id: true, name: true, email: true, status: true, lastLoginAt: true, mfaEnabled: true, title: true } }, role: { select: { id: true, name: true, key: true, rank: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      tx.team.findMany({ where: { organizationId: org }, include: { members: { select: { userId: true } } }, orderBy: { name: 'asc' } }),
      tx.invitation.findMany({ where: { organizationId: org, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } }),
      tx.userTarget.findMany({ where: { organizationId: org, period: new Date().toISOString().slice(0, 7) } }),
    ]);
    const perf = await tx.$queryRaw<{ user_id: string; leads: bigint; open: bigint; converted_mtd: bigint; contacts_mtd: bigint; overdue_tasks: bigint }[]>`
      SELECT u.id AS user_id,
        (SELECT count(*) FROM client_leads c WHERE c."organizationId" = ${org} AND c."ownerId" = u.id AND c."revokedAt" IS NULL AND c."archivedAt" IS NULL) AS leads,
        (SELECT count(*) FROM client_leads c WHERE c."organizationId" = ${org} AND c."ownerId" = u.id AND c."revokedAt" IS NULL AND c."archivedAt" IS NULL AND c.status NOT IN ('CONVERTED','LOST')) AS open,
        (SELECT count(*) FROM client_leads c WHERE c."organizationId" = ${org} AND c."ownerId" = u.id AND c."convertedAt" >= date_trunc('month', now())) AS converted_mtd,
        (SELECT count(*) FROM communication_logs m WHERE m."organizationId" = ${org} AND m."userId" = u.id AND m."occurredAt" >= date_trunc('month', now())) AS contacts_mtd,
        (SELECT count(*) FROM tasks t WHERE t."organizationId" = ${org} AND t."assigneeId" = u.id AND t.status IN ('OPEN','IN_PROGRESS') AND t."dueAt" < now()) AS overdue_tasks
      FROM users u JOIN memberships m ON m."userId" = u.id WHERE m."organizationId" = ${org}`;
    const pm = new Map(perf.map((p) => [p.user_id, p]));
    const roleNames = await tx.role.findMany({ where: { id: { in: invitations.map((i) => i.roleId) } }, select: { id: true, name: true } });
    const rn = new Map(roleNames.map((r) => [r.id, r.name]));
    return {
      members: members.map((m) => {
        const p = pm.get(m.userId);
        const t = targets.filter((x) => x.userId === m.userId);
        return {
          ...m.user, role: m.role,
          leads: Number(p?.leads ?? 0), open: Number(p?.open ?? 0), convertedMtd: Number(p?.converted_mtd ?? 0), contactsMtd: Number(p?.contacts_mtd ?? 0), overdueTasks: Number(p?.overdue_tasks ?? 0),
          targets: Object.fromEntries(t.map((x) => [x.metric, x.target])),
        };
      }),
      teams: teams.map((t) => ({ id: t.id, name: t.name, description: t.description, managerId: t.managerId, memberIds: t.members.map((m) => m.userId) })),
      invitations: invitations.map((i) => ({ id: i.id, email: i.email, name: i.name, role: rn.get(i.roleId) ?? '—', expiresAt: i.expiresAt })),
    };
  });
}

export const teamInput = z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).nullable().optional(), managerId: z.string().max(64).nullable().optional(), memberIds: z.array(z.string().max(64)).max(500) });

export async function upsertTeam(ctx: AuthContext, id: string | null, input: z.infer<typeof teamInput>) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    for (const u of [...input.memberIds, ...(input.managerId ? [input.managerId] : [])]) await assertMember(tx, org, u);
    const team = id
      ? await tx.team.update({ where: { id, organizationId: org }, data: { name: input.name, description: input.description ?? null, managerId: input.managerId ?? null } })
      : await tx.team.create({ data: { organizationId: org, name: input.name, description: input.description ?? null, managerId: input.managerId ?? null } });
    await tx.teamMember.deleteMany({ where: { teamId: team.id } });
    await tx.teamMember.createMany({ data: [...new Set(input.memberIds)].map((userId) => ({ teamId: team.id, userId, organizationId: org })) });
    await audit(tx, ctx, { action: id ? 'crm.team.updated' : 'crm.team.created', targetType: 'team', targetId: team.id, after: input });
    return team;
  });
}

export async function deleteTeam(ctx: AuthContext, id: string) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const t = await tx.team.findFirst({ where: { id, organizationId: org } });
    if (!t) throw notFound('Team');
    await tx.team.delete({ where: { id } });
    await audit(tx, ctx, { action: 'crm.team.deleted', targetType: 'team', targetId: id, before: { name: t.name } });
  });
}

export async function setTarget(ctx: AuthContext, userId: string, metric: 'CONTACTS' | 'CONVERSIONS', target: number) {
  const org = tenantOf(ctx);
  const period = new Date().toISOString().slice(0, 7);
  return withTenant(org, async (tx) => {
    await assertMember(tx, org, userId);
    const row = await tx.userTarget.upsert({
      where: { organizationId_userId_period_metric: { organizationId: org, userId, period, metric } },
      create: { organizationId: org, userId, period, metric, target, createdById: ctx.user.id },
      update: { target },
    });
    await audit(tx, ctx, { action: 'crm.target.set', targetType: 'user', targetId: userId, after: { metric, target, period } });
    return row;
  });
}

/** Moves every open lead (and open task) owned by one member to another, e.g. before deactivation. */
export async function transferOwnership(ctx: AuthContext, fromUserId: string, toUserId: string) {
  const org = tenantOf(ctx);
  if (fromUserId === toUserId) throw new AppError('VALIDATION_FAILED', 'Choose a different recipient');
  return withTenant(org, async (tx) => {
    const fromM = await tx.membership.findFirst({ where: { organizationId: org, userId: fromUserId } });
    if (!fromM) throw notFound('User');
    await assertMember(tx, org, toUserId);
    const leads = await tx.clientLead.findMany({ where: { organizationId: org, ownerId: fromUserId, revokedAt: null, status: { notIn: ['CONVERTED', 'LOST'] } }, select: { id: true, leadId: true } });
    await tx.clientLead.updateMany({ where: { id: { in: leads.map((l) => l.id) } }, data: { ownerId: toUserId } });
    const tasks = await tx.task.updateMany({ where: { organizationId: org, assigneeId: fromUserId, status: { in: ['OPEN', 'IN_PROGRESS'] } }, data: { assigneeId: toUserId, delegatedById: ctx.user.id } });
    await tx.activity.createMany({ data: leads.map((l) => ({ organizationId: org, clientLeadId: l.id, leadId: l.leadId, actorId: ctx.user.id, type: ACTIVITY.OWNER_CHANGED, summary: 'Ownership transferred', data: { from: fromUserId, to: toUserId } })) });
    await audit(tx, ctx, { action: 'crm.ownership.transferred', targetType: 'user', targetId: fromUserId, after: { toUserId, leads: leads.length, tasks: tasks.count } });
    await notifyUsers([toUserId], { type: 'LEADS_TRANSFERRED', title: `${leads.length} leads and ${tasks.count} tasks were transferred to you`, link: '/app/leads', organizationId: org }, tx);
    return { leads: leads.length, tasks: tasks.count };
  });
}

// ── Pipeline, custom fields, templates, settings ───────────────────

export const stageInput = z.object({
  stages: z.array(z.object({
    id: z.string().max(64).optional(),
    name: z.string().trim().min(1).max(60),
    category: z.enum(['OPEN', 'WON', 'LOST']),
    probability: z.number().int().min(0).max(100),
    stagnantAfterDays: z.number().int().min(1).max(365).nullable(),
    requiresApproval: z.boolean(),
  })).min(3).max(20),
});

export async function savePipelineStages(ctx: AuthContext, input: z.infer<typeof stageInput>) {
  const org = tenantOf(ctx);
  const cats = input.stages.map((s) => s.category);
  if (!cats.includes('WON') || !cats.includes('LOST') || !cats.includes('OPEN')) throw new AppError('VALIDATION_FAILED', 'A pipeline needs at least one open, one won and one lost stage');
  return withTenant(org, async (tx) => {
    const pipeline = await tx.pipeline.findFirst({ where: { organizationId: org, isDefault: true }, include: { stages: true } });
    if (!pipeline) throw notFound('Pipeline');
    const keep = new Set(input.stages.map((s) => s.id).filter(Boolean));
    const removed = pipeline.stages.filter((s) => !keep.has(s.id));
    for (const r of removed) {
      const inUse = await tx.clientLead.count({ where: { stageId: r.id, revokedAt: null } });
      if (inUse) throw new AppError('CONFLICT', `“${r.name}” still has ${inUse} lead(s). Move them before removing the stage.`);
    }
    await tx.pipelineStage.deleteMany({ where: { id: { in: removed.map((r) => r.id) } } });
    for (const [i, s] of input.stages.entries()) {
      const data = { name: s.name, category: s.category, probability: s.probability, stagnantAfterDays: s.stagnantAfterDays, requiresApproval: s.requiresApproval, position: i };
      if (s.id && pipeline.stages.some((x) => x.id === s.id)) await tx.pipelineStage.update({ where: { id: s.id }, data });
      else await tx.pipelineStage.create({ data: { ...data, organizationId: org, pipelineId: pipeline.id } });
    }
    await audit(tx, ctx, { action: 'crm.pipeline.updated', targetType: 'pipeline', targetId: pipeline.id, before: pipeline.stages.map((s) => s.name), after: input.stages.map((s) => s.name) });
    return { ok: true };
  });
}

export const fieldInput = z.object({
  fields: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Keys use lowercase letters, digits and underscores'),
    label: z.string().trim().min(1).max(60),
    type: z.enum(['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN']),
    options: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
    required: z.boolean().default(false),
  })).max(40),
});

export async function saveCustomFields(ctx: AuthContext, input: z.infer<typeof fieldInput>) {
  const org = tenantOf(ctx);
  const keys = input.fields.map((f) => f.key);
  if (new Set(keys).size !== keys.length) throw new AppError('VALIDATION_FAILED', 'Field keys must be unique');
  return withTenant(org, async (tx) => {
    const before = await tx.customFieldDefinition.findMany({ where: { organizationId: org } });
    await tx.customFieldDefinition.deleteMany({ where: { organizationId: org, key: { notIn: keys } } });
    for (const [i, f] of input.fields.entries()) {
      await tx.customFieldDefinition.upsert({
        where: { organizationId_key: { organizationId: org, key: f.key } },
        create: { ...f, organizationId: org, position: i },
        update: { label: f.label, type: f.type, options: f.options, required: f.required, position: i },
      });
    }
    await audit(tx, ctx, { action: 'crm.custom_fields.updated', targetType: 'organization', targetId: org, before: before.map((b) => b.key), after: keys });
    return { ok: true };
  });
}

export const templateInput = z.object({ channel: z.enum(['CALL', 'EMAIL', 'SMS', 'WHATSAPP', 'MEETING']), name: z.string().trim().min(2).max(80), subject: z.string().trim().max(200).nullable().optional(), body: z.string().trim().min(1).max(5000) });

export async function listTemplates(ctx: AuthContext) {
  const org = tenantOf(ctx);
  return withTenant(org, (tx) => tx.communicationTemplate.findMany({ where: { organizationId: org }, orderBy: { name: 'asc' } }));
}

export async function upsertTemplate(ctx: AuthContext, id: string | null, input: z.infer<typeof templateInput>) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const t = id
      ? await tx.communicationTemplate.update({ where: { id, organizationId: org }, data: input })
      : await tx.communicationTemplate.create({ data: { ...input, organizationId: org, createdById: ctx.user.id } });
    await audit(tx, ctx, { action: id ? 'crm.template.updated' : 'crm.template.created', targetType: 'template', targetId: t.id, after: { name: input.name, channel: input.channel } });
    return t;
  });
}

export async function deleteTemplate(ctx: AuthContext, id: string) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const t = await tx.communicationTemplate.findFirst({ where: { id, organizationId: org } });
    if (!t) throw notFound('Template');
    await tx.communicationTemplate.delete({ where: { id } });
    await audit(tx, ctx, { action: 'crm.template.deleted', targetType: 'template', targetId: id });
  });
}

export const clientSettingsInput = z.object({
  branding: z.object({ primaryLabel: z.string().trim().max(60).optional() }).optional(),
  security: z.object({
    mfaRequired: z.boolean(),
    sessionIdleMinutes: z.number().int().min(5).max(720),
    revealRequiresReason: z.boolean(),
    ipAllowlist: z.array(z.string().trim().regex(/^[0-9a-fA-F:.*]+$/).max(64)).max(100),
  }).partial().optional(),
  workflows: z.object({ staleLeadDays: z.number().int().min(1).max(365), firstContactSlaHours: z.number().int().min(1).max(720) }).partial().optional(),
  profile: z.object({
    contactEmail: z.string().trim().email().max(254).nullable(), contactPhone: z.string().trim().max(40).nullable(), address: z.string().trim().max(400).nullable(), timezone: z.string().trim().max(60),
    legalName: z.string().trim().max(160).nullable(),
    gstin: z.string().trim().toUpperCase().max(15).nullable().refine((v) => !v || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v), 'Enter a valid 15-character GSTIN'),
    billingState: z.string().trim().max(60).nullable(),
  }).partial().optional(),
});

/**
 * Workspace-admin settings. Clients may tighten security but cannot weaken controls the platform
 * imposes (e.g. the watermark, or MFA once required by the platform), nor touch features/quotas.
 */
export async function updateClientSettings(ctx: AuthContext, input: z.infer<typeof clientSettingsInput>) {
  const org = tenantOf(ctx);
  const policy = await getSetting('security.policy');
  return withPlatform(async (tx) => {
    const o = await tx.organization.findUniqueOrThrow({ where: { id: org } });
    const current = orgSettings(o.settings);
    const platformLocks = ((o.settings as { platformLocks?: { mfaRequired?: boolean } }).platformLocks ?? {});
    const sec = { ...current.security };
    if (input.security) {
      const s = input.security;
      if (s.mfaRequired === false && platformLocks.mfaRequired) throw new AppError('FORBIDDEN', 'Two-factor authentication is required by the platform and cannot be disabled here');
      if (s.mfaRequired !== undefined) sec.mfaRequired = s.mfaRequired;
      if (s.sessionIdleMinutes !== undefined) sec.sessionIdleMinutes = Math.min(s.sessionIdleMinutes, policy.sessionIdleMinutes);
      if (s.revealRequiresReason !== undefined) sec.revealRequiresReason = s.revealRequiresReason;
      if (s.ipAllowlist !== undefined) {
        if (s.ipAllowlist.length && ctx.ip && !s.ipAllowlist.some((e) => (e.endsWith('*') ? ctx.ip!.startsWith(e.slice(0, -1)) : ctx.ip === e))) {
          throw new AppError('VALIDATION_FAILED', `Your current IP (${ctx.ip}) is not in the allowlist — saving would lock you out`);
        }
        sec.ipAllowlist = s.ipAllowlist;
      }
    }
    const next = {
      ...(o.settings as object),
      security: sec,
      branding: { ...current.branding, ...(input.branding ?? {}) },
      workflows: { ...current.workflows, ...(input.workflows ?? {}) },
    };
    await tx.organization.update({ where: { id: org }, data: { settings: next as Prisma.InputJsonValue, ...(input.profile ?? {}) } });
    await audit(tx, ctx, { action: 'crm.settings.updated', targetType: 'organization', targetId: org, organizationId: org, before: { security: current.security, workflows: current.workflows }, after: { security: sec, workflows: next.workflows, profile: input.profile } });
    return next;
  });
}

export async function workspaceAudit(ctx: AuthContext, params: { page: number; pageSize: number; action?: string }) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const where: Prisma.AuditEventWhereInput = { organizationId: org, ...(params.action ? { action: { startsWith: params.action } } : {}) };
    const [total, rows] = await Promise.all([
      tx.auditEvent.count({ where }),
      tx.auditEvent.findMany({ where, orderBy: { seq: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize, select: { id: true, action: true, actorEmail: true, targetType: true, targetId: true, result: true, reason: true, createdAt: true, ip: true } }),
    ]);
    return { total, rows };
  });
}

export async function orgMembers(organizationId: string) {
  return prisma.membership.findMany({ where: { organizationId, user: { status: 'ACTIVE' } }, select: { user: { select: { id: true, name: true } } } });
}
