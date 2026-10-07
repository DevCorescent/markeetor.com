import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Filter } from '@/lib/filters';
import { sequenceInput, type SequenceStep } from '@/lib/marketing';
import { audit } from '../audit';
import { can, type AuthContext } from '../auth/context';
import { withPlatform, withTenant } from '../db';
import { AppError, notFound } from '../errors';
import { logger } from '../logger';
import { queueAutomationEmail, startCampaign } from './email';
import { assertClean, assertFeature, getMarketing, segmentWhere, sendToLead } from './marketing';

/**
 * Follow-up sequences: ordered steps (email template, WhatsApp, SMS, task) with delays. The worker runs due
 * steps every minute. An enrolment stops when the lead replies (inbound message logged after enrolment),
 * reaches a stop status (e.g. Converted / Lost), opts out, or is no longer in the workspace.
 */

type Input = z.infer<typeof sequenceInput>;
const hours = (h: number) => new Date(Date.now() + h * 3_600_000);

async function validate(ctx: AuthContext, input: Input) {
  const s = await assertFeature(ctx, 'sequences');
  if (input.steps.length > s.limits.stepsPerSequence) throw new AppError('VALIDATION_FAILED', `Sequences can have up to ${s.limits.stepsPerSequence} steps`);
  for (const st of input.steps) {
    if (st.type === 'email' && !st.templateId) throw new AppError('VALIDATION_FAILED', 'Choose an email template for every email step');
    if ((st.type === 'whatsapp' || st.type === 'sms') && !st.body) throw new AppError('VALIDATION_FAILED', 'Write the message for every WhatsApp / SMS step');
    if (st.type === 'task' && !st.title) throw new AppError('VALIDATION_FAILED', 'Give every task step a title');
    if (st.type === 'whatsapp') await assertFeature(ctx, 'whatsapp');
    if (st.type === 'sms') await assertFeature(ctx, 'sms');
    if (st.body) assertClean(st.body, s);
  }
  return s;
}

export async function listSequences(ctx: AuthContext) {
  await assertFeature(ctx, 'sequences');
  return withPlatform(async (tx) => {
    const rows = await tx.sequence.findMany({ where: { organizationId: ctx.orgId! }, orderBy: { createdAt: 'desc' } });
    const stats = await tx.sequenceEnrollment.groupBy({ by: ['sequenceId', 'status'], where: { organizationId: ctx.orgId! }, _count: true });
    return rows.map((r) => ({ ...r, stats: Object.fromEntries(stats.filter((x) => x.sequenceId === r.id).map((x) => [x.status, x._count])) }));
  });
}

export async function getSequence(ctx: AuthContext, id: string) {
  const r = await withPlatform((tx) => tx.sequence.findUnique({ where: { id } }));
  if (!r || r.organizationId !== ctx.orgId) throw notFound('Sequence');
  const enrollments = await withPlatform((tx) => tx.sequenceEnrollment.findMany({ where: { sequenceId: id }, orderBy: { enrolledAt: 'desc' }, take: 100 }));
  const leads = await withTenant(ctx.orgId!, (tx) => tx.clientLead.findMany({ where: { id: { in: enrollments.map((e) => e.clientLeadId) } }, select: { id: true, fullName: true, company: true } }));
  return { ...r, enrollments: enrollments.map((e) => ({ ...e, lead: leads.find((l) => l.id === e.clientLeadId) ?? null })) };
}

export async function saveSequence(ctx: AuthContext, id: string | null, input: Input) {
  const s = await validate(ctx, input);
  return withPlatform(async (tx) => {
    if (input.segmentId && !(await tx.marketingSegment.findFirst({ where: { id: input.segmentId, organizationId: ctx.orgId! } }))) throw notFound('Segment');
    const data = { name: input.name, steps: input.steps as unknown as Prisma.InputJsonValue, stopOnReply: input.stopOnReply, stopOnStatus: input.stopOnStatus, segmentId: input.segmentId, autoEnroll: input.autoEnroll && Boolean(input.segmentId) };
    if (id) {
      const e = await tx.sequence.findUnique({ where: { id } });
      if (!e || e.organizationId !== ctx.orgId) throw notFound('Sequence');
      return tx.sequence.update({ where: { id }, data });
    }
    if ((await tx.sequence.count({ where: { organizationId: ctx.orgId! } })) >= s.limits.sequences) throw new AppError('CONFLICT', `You can have up to ${s.limits.sequences} sequences`);
    const r = await tx.sequence.create({ data: { ...data, organizationId: ctx.orgId!, createdById: ctx.user.id } });
    await audit(tx, ctx, { action: 'marketing.sequence.created', targetType: 'sequence', targetId: r.id, metadata: { name: r.name, steps: input.steps.length } });
    return r;
  });
}

export async function setSequenceStatus(ctx: AuthContext, id: string, status: 'ACTIVE' | 'PAUSED') {
  await assertFeature(ctx, 'sequences');
  return withPlatform(async (tx) => {
    const e = await tx.sequence.findUnique({ where: { id } });
    if (!e || e.organizationId !== ctx.orgId) throw notFound('Sequence');
    const u = await tx.sequence.update({ where: { id }, data: { status } });
    await audit(tx, ctx, { action: `marketing.sequence.${status === 'ACTIVE' ? 'activated' : 'paused'}`, targetType: 'sequence', targetId: id });
    return u;
  });
}

export async function deleteSequence(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const e = await tx.sequence.findUnique({ where: { id } });
    if (!e || e.organizationId !== ctx.orgId) throw notFound('Sequence');
    await tx.sequence.delete({ where: { id } });
    await audit(tx, ctx, { action: 'marketing.sequence.deleted', targetType: 'sequence', targetId: id });
    return { ok: true };
  });
}

/** Enrols leads (by id, or a whole segment). Already-enrolled leads are left alone. */
export async function enroll(ctx: AuthContext | null, sequenceId: string, target: { clientLeadIds?: string[]; segmentId?: string }, opts: { orgId?: string; actorId?: string } = {}) {
  const orgId = ctx?.orgId ?? opts.orgId!;
  if (ctx) await assertFeature(ctx, 'sequences');
  const seq = await withPlatform((tx) => tx.sequence.findUnique({ where: { id: sequenceId } }));
  if (!seq || seq.organizationId !== orgId) throw notFound('Sequence');
  if (seq.status !== 'ACTIVE') throw new AppError('CONFLICT', 'Activate the sequence before enrolling leads');
  const steps = seq.steps as unknown as SequenceStep[];
  let ids = target.clientLeadIds ?? [];
  if (target.segmentId) {
    const seg = await withPlatform((tx) => tx.marketingSegment.findFirst({ where: { id: target.segmentId, organizationId: orgId } }));
    if (!seg) throw notFound('Segment');
    ids = (await withTenant(orgId, (tx) => tx.clientLead.findMany({ where: segmentWhere(orgId, seg.filter as Filter), select: { id: true }, take: 5000 }))).map((l) => l.id);
  }
  // Members only enrol their own leads.
  if (ctx && !can(ctx, 'crm.leads.read_all')) ids = (await withTenant(orgId, (tx) => tx.clientLead.findMany({ where: { id: { in: ids }, ownerId: ctx.user.id }, select: { id: true } }))).map((l) => l.id);
  const valid = (await withTenant(orgId, (tx) => tx.clientLead.findMany({ where: { id: { in: ids }, organizationId: orgId, revokedAt: null, status: { notIn: seq.stopOnStatus as never[] } }, select: { id: true } }))).map((l) => l.id);
  const r = await withPlatform((tx) => tx.sequenceEnrollment.createMany({
    data: valid.map((clientLeadId) => ({ organizationId: orgId, sequenceId, clientLeadId, nextRunAt: hours(steps[0]?.delayHours ?? 0), enrolledById: ctx?.user.id ?? opts.actorId ?? seq.createdById })),
    skipDuplicates: true,
  }));
  if (r.count) await withPlatform((tx) => tx.sequence.update({ where: { id: sequenceId }, data: { enrolledCount: { increment: r.count } } }));
  return { enrolled: r.count, skipped: ids.length - r.count };
}

export async function unenroll(ctx: AuthContext, enrollmentId: string) {
  return withPlatform(async (tx) => {
    const e = await tx.sequenceEnrollment.findUnique({ where: { id: enrollmentId } });
    if (!e || e.organizationId !== ctx.orgId) throw notFound('Enrolment');
    return tx.sequenceEnrollment.update({ where: { id: enrollmentId }, data: { status: 'STOPPED', stopReason: 'removed', nextRunAt: null } });
  });
}

export async function leadEnrollments(ctx: AuthContext, clientLeadId: string) {
  const rows = await withPlatform((tx) => tx.sequenceEnrollment.findMany({ where: { organizationId: ctx.orgId!, clientLeadId }, include: { sequence: { select: { name: true, steps: true } } }, orderBy: { enrolledAt: 'desc' } }));
  return rows.map((r) => ({ id: r.id, sequenceId: r.sequenceId, name: r.sequence.name, status: r.status, stepIndex: r.stepIndex, steps: (r.sequence.steps as unknown as SequenceStep[]).length, nextRunAt: r.nextRunAt, stopReason: r.stopReason }));
}

/** Stops every active enrolment of a lead (reply, opt-out). */
export async function stopEnrollments(orgId: string, clientLeadId: string, reason: string) {
  await withPlatform((tx) => tx.sequenceEnrollment.updateMany({ where: { organizationId: orgId, clientLeadId, status: 'ACTIVE', ...(reason === 'replied' ? { sequence: { stopOnReply: true } } : {}) }, data: { status: 'STOPPED', stopReason: reason, nextRunAt: null } }));
}

/** Worker: runs due steps, stops finished/replied/converted enrolments and auto-enrols segment members. */
export async function runSequences(batch = 200) {
  const s = await getMarketing();
  if (!s.enabled) return { ran: 0 };
  // Auto-enrol new members of linked segments.
  const auto = await withPlatform((tx) => tx.sequence.findMany({ where: { status: 'ACTIVE', autoEnroll: true, segmentId: { not: null } } }));
  for (const q of auto) await enroll(null, q.id, { segmentId: q.segmentId! }, { orgId: q.organizationId, actorId: q.createdById }).catch((err) => logger.warn({ err, sequence: q.id }, 'auto-enrol failed'));

  const due = await withPlatform((tx) => tx.sequenceEnrollment.findMany({ where: { status: 'ACTIVE', nextRunAt: { lte: new Date() }, sequence: { status: 'ACTIVE' } }, include: { sequence: true }, orderBy: { nextRunAt: 'asc' }, take: batch }));
  let ran = 0;
  for (const e of due) {
    const seq = e.sequence;
    const steps = seq.steps as unknown as SequenceStep[];
    const set = (data: Prisma.SequenceEnrollmentUpdateInput) => withPlatform((tx) => tx.sequenceEnrollment.update({ where: { id: e.id }, data }));
    try {
      const lead = await withTenant(e.organizationId, (tx) => tx.clientLead.findFirst({ where: { id: e.clientLeadId, organizationId: e.organizationId }, select: { id: true, status: true, revokedAt: true, ownerId: true, fullName: true } }));
      if (!lead || lead.revokedAt) { await set({ status: 'STOPPED', stopReason: 'lead removed', nextRunAt: null }); continue; }
      if (seq.stopOnStatus.includes(lead.status)) { await set({ status: 'STOPPED', stopReason: `status:${lead.status}`, nextRunAt: null }); continue; }
      if (seq.stopOnReply) {
        const reply = await withTenant(e.organizationId, (tx) => tx.communicationLog.findFirst({ where: { clientLeadId: lead.id, direction: 'INBOUND', occurredAt: { gte: e.enrolledAt } }, select: { id: true } }));
        if (reply) { await set({ status: 'STOPPED', stopReason: 'replied', nextRunAt: null }); continue; }
      }
      const step = steps[e.stepIndex];
      if (!step) { await set({ status: 'COMPLETED', nextRunAt: null }); continue; }
      let note: string | null = null;
      if (step.type === 'email') {
        const r = await withPlatform((tx) => queueAutomationEmail(tx, { organizationId: e.organizationId, clientLeadId: lead.id, templateId: step.templateId!, workflowId: `seq:${seq.id}`, workflowName: seq.name, actorId: seq.createdById }));
        if (r.campaignId) await startCampaign(r.campaignId);
        if (r.result.startsWith('skipped')) note = r.result;
      } else if (step.type === 'whatsapp' || step.type === 'sms') {
        const r = await sendToLead({ organizationId: e.organizationId, clientLeadId: lead.id, channel: step.type === 'whatsapp' ? 'WHATSAPP' : 'SMS', body: step.body ?? '', actorId: seq.createdById, sequenceId: seq.id, enrollmentId: e.id });
        if (r.status === 'DEFERRED') { await set({ nextRunAt: r.retryAt ?? hours(1) }); continue; }
        if (r.status === 'SKIPPED' || r.status === 'FAILED') note = r.reason ?? r.status.toLowerCase();
        if (r.reason?.startsWith('Lead opted out')) { await set({ status: 'STOPPED', stopReason: 'opted_out', nextRunAt: null, lastError: r.reason }); continue; }
      } else if (step.type === 'task') {
        await withTenant(e.organizationId, (tx) => tx.task.create({ data: { organizationId: e.organizationId, clientLeadId: lead.id, title: step.title ?? 'Follow up', type: /call/i.test(step.title ?? '') ? 'CALL' : 'FOLLOW_UP', dueAt: new Date(), assigneeId: lead.ownerId ?? seq.createdById, createdById: seq.createdById, description: `From sequence “${seq.name}”` } }));
      }
      const next = steps[e.stepIndex + 1];
      await set({ stepIndex: e.stepIndex + 1, lastError: note, ...(next ? { nextRunAt: hours(next.delayHours) } : { status: 'COMPLETED', nextRunAt: null }) });
      ran++;
    } catch (err) {
      logger.warn({ err, enrollment: e.id }, 'sequence step failed');
      await set({ lastError: (err as Error).message.slice(0, 300), nextRunAt: hours(1) }).catch(() => null);
    }
  }
  return { ran };
}

// ── Template library (published by the platform team) ──────────────

export const libraryTemplateInput = z.object({ kind: z.enum(['SEQUENCE', 'WHATSAPP', 'SMS']), name: z.string().trim().min(2).max(120), description: z.string().trim().max(300).nullable().optional(), content: z.unknown(), published: z.boolean().default(true) });

export async function listLibrary(opts: { all?: boolean } = {}) {
  return withPlatform((tx) => tx.marketingTemplate.findMany({ where: opts.all ? {} : { published: true }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] }));
}

export async function saveLibraryTemplate(ctx: AuthContext, id: string | null, input: { kind: 'SEQUENCE' | 'WHATSAPP' | 'SMS'; name: string; description?: string | null; content: unknown; published: boolean }) {
  if (input.kind === 'SEQUENCE') sequenceInput.parse(input.content);
  return withPlatform(async (tx) => {
    const data = { kind: input.kind, name: input.name, description: input.description ?? null, content: input.content as Prisma.InputJsonValue, published: input.published };
    const r = id ? await tx.marketingTemplate.update({ where: { id }, data }) : await tx.marketingTemplate.create({ data: { ...data, createdById: ctx.user.id } });
    await audit(tx, ctx, { action: id ? 'marketing.template.updated' : 'marketing.template.created', targetType: 'marketing_template', targetId: r.id, organizationId: null, metadata: { name: r.name, kind: r.kind } });
    return r;
  });
}

export async function deleteLibraryTemplate(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    await tx.marketingTemplate.delete({ where: { id } }).catch(() => { throw notFound('Template'); });
    await audit(tx, ctx, { action: 'marketing.template.deleted', targetType: 'marketing_template', targetId: id, organizationId: null });
    return { ok: true };
  });
}

/** Copies a library sequence into the workspace as a draft (email steps need the workspace's own template). */
export async function useLibrarySequence(ctx: AuthContext, templateId: string) {
  const t = await withPlatform((tx) => tx.marketingTemplate.findUnique({ where: { id: templateId } }));
  if (!t || !t.published || t.kind !== 'SEQUENCE') throw notFound('Template');
  const c = sequenceInput.parse(t.content);
  const steps = c.steps.filter((s) => s.type !== 'email');
  if (!steps.length) throw new AppError('VALIDATION_FAILED', 'This template only has email steps — add your own email template first');
  return saveSequence(ctx, null, { ...c, steps, segmentId: null, autoEnroll: false, name: c.name });
}
