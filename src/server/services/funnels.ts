import type { Funnel, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { conditionSchema, type Condition } from '@/lib/filters';
import { audit } from '../audit';
import { can, type AuthContext } from '../auth/context';
import { withPlatform, withTenant, type Tx } from '../db';
import { AppError, notFound } from '../errors';
import { logger } from '../logger';
import { createCampaign, queueAutomationEmail, startCampaign } from './email';
import { buildClientLeadWhere } from './lead-filters';
import { notifyUsers } from './notifications';

/**
 * Client funnels. A funnel is an ordered list of stages; each stage is defined by lead conditions (status,
 * pipeline stage, tags, activity, score…). A lead has "reached" a stage when it matches that stage or any
 * later one, and is "currently in" the deepest stage it has reached. Campaigns target a stage (email, tasks
 * or owner notifications), and stage automations act once on every lead that enters a stage.
 */

const automationSchema = z.object({
  enabled: z.boolean().default(false),
  action: z.enum(['EMAIL', 'TASK', 'NOTIFY']).default('EMAIL'),
  templateId: z.string().max(64).nullable().optional(),
  taskTitle: z.string().trim().max(200).nullable().optional(),
  dueInHours: z.number().int().min(0).max(720).default(24),
  message: z.string().trim().max(300).nullable().optional(),
  /** When switched on, leads already in the stage are not acted on — only new arrivals. */
  onlyNew: z.boolean().default(true),
});

const stageSchema = z.object({
  id: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).nullable().optional(),
  conditions: z.array(conditionSchema).max(15).default([]),
  automation: automationSchema.nullable().optional(),
});
export type FunnelStage = z.infer<typeof stageSchema>;

export const funnelInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  goal: z.string().trim().max(160).nullable().optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).default('ACTIVE'),
  baseFilter: z.object({ conditions: z.array(conditionSchema).max(15).default([]) }).default({ conditions: [] }),
  stages: z.array(stageSchema).min(2, 'A funnel needs at least two stages').max(10),
}).refine((f) => new Set(f.stages.map((s) => s.id)).size === f.stages.length, 'Stage ids must be unique');
export type FunnelInput = z.infer<typeof funnelInput>;

const stagesOf = (f: Pick<Funnel, 'stages'>) => (f.stages as unknown as FunnelStage[]) ?? [];
const baseOf = (f: Pick<Funnel, 'baseFilter'>) => ((f.baseFilter as { conditions?: Condition[] } | null)?.conditions ?? []);
const ownerScope = (ctx: AuthContext | null) => (ctx && !can(ctx, 'crm.leads.read_all') ? ctx.user.id : null);

// ── Stage membership ───────────────────────────────────────────────

function where(orgId: string, f: Pick<Funnel, 'stages' | 'baseFilter'>, ownerOnly: string | null) {
  const stages = stagesOf(f);
  const base = buildClientLeadWhere(orgId, { conditions: baseOf(f) }, { ownerOnly, view: 'active' });
  // A stage without conditions matches every lead (Prisma ignores `{}` inside OR, so handle it explicitly).
  const match = (st: FunnelStage): Prisma.ClientLeadWhereInput | null => (st.conditions.length ? buildClientLeadWhere(orgId, { conditions: st.conditions }, { view: 'active' }) : null);
  const anyOf = (list: FunnelStage[]): Prisma.ClientLeadWhereInput | 'ALL' => {
    const ws = list.map(match);
    return ws.some((x) => x === null) ? 'ALL' : { OR: ws as Prisma.ClientLeadWhereInput[] };
  };
  const reached = (i: number): Prisma.ClientLeadWhereInput => {
    const a = anyOf(stages.slice(i));
    return a === 'ALL' ? base : { AND: [base, a] };
  };
  const current = (i: number): Prisma.ClientLeadWhereInput => {
    if (i >= stages.length - 1) return reached(i);
    const later = anyOf(stages.slice(i + 1));
    return later === 'ALL' ? { id: { in: [] } } : { AND: [reached(i), { NOT: later }] };
  };
  return { base, reached, current, stages };
}

export async function analyzeFunnel(tx: Tx, orgId: string, f: Pick<Funnel, 'stages' | 'baseFilter'>, ownerOnly: string | null) {
  const w = where(orgId, f, ownerOnly);
  const total = await tx.clientLead.count({ where: w.base });
  const rows: { id: string; name: string; reached: number; current: number; value: number; avgScore: number }[] = [];
  for (let i = 0; i < w.stages.length; i++) {
    const [reached, current, value] = await Promise.all([
      tx.clientLead.count({ where: w.reached(i) }),
      tx.clientLead.count({ where: w.current(i) }),
      tx.clientLead.aggregate({ where: w.current(i), _sum: { dealValue: true }, _avg: { score: true } }),
    ]);
    rows.push({ id: w.stages[i].id, name: w.stages[i].name, reached, current, value: Number(value._sum.dealValue ?? 0), avgScore: Math.round(value._avg.score ?? 0) });
  }
  const out = rows.map((r, i) => ({
    ...r,
    conversion: i === 0 ? (total ? r.reached / total : 0) : rows[i - 1].reached ? r.reached / rows[i - 1].reached : 0,
    dropOff: i < rows.length - 1 ? Math.max(0, r.reached - rows[i + 1].reached) : 0,
  }));
  const first = out[0]?.reached ?? 0;
  const last = out[out.length - 1]?.reached ?? 0;
  // The stage that loses the most leads relative to its size is the biggest opportunity.
  const bottleneck = out.slice(0, -1).reduce<{ id: string; rate: number } | null>((b, r, i) => {
    const rate = r.reached ? 1 - out[i + 1].reached / r.reached : 0;
    return !b || rate > b.rate ? { id: r.id, rate } : b;
  }, null);
  return { total, stages: out, overallConversion: first ? last / first : 0, bottleneck: bottleneck && bottleneck.rate > 0 ? bottleneck : null };
}

// ── CRUD ───────────────────────────────────────────────────────────

export async function listFunnels(ctx: AuthContext) {
  const org = ctx.orgId!;
  return withTenant(org, async (tx) => {
    const rows = await tx.funnel.findMany({ where: { organizationId: org, status: { not: 'ARCHIVED' } }, orderBy: { updatedAt: 'desc' }, include: { _count: { select: { campaigns: true } } } });
    const out = [];
    for (const f of rows) out.push({ ...f, campaignCount: f._count.campaigns, analysis: await analyzeFunnel(tx, org, f, ownerScope(ctx)) });
    return out;
  }, { timeout: 30_000 });
}

export async function getFunnel(ctx: AuthContext, id: string) {
  const org = ctx.orgId!;
  return withTenant(org, async (tx) => {
    const f = await tx.funnel.findFirst({ where: { id, organizationId: org } });
    if (!f) throw notFound('Funnel');
    const analysis = await analyzeFunnel(tx, org, f, ownerScope(ctx));
    const campaigns = await tx.funnelCampaign.findMany({ where: { funnelId: id }, orderBy: { createdAt: 'desc' }, take: 50 });
    const emailIds = campaigns.map((c) => c.emailCampaignId).filter(Boolean) as string[];
    const emails = emailIds.length ? await tx.emailCampaign.findMany({ where: { id: { in: emailIds } }, select: { id: true, status: true, sentCount: true, openedCount: true, failedCount: true, skippedCount: true, totalRecipients: true } }) : [];
    const enrolled = await tx.funnelEnrollment.groupBy({ by: ['stageId'], where: { funnelId: id, NOT: { result: 'baseline' } }, _count: true });
    return {
      funnel: f, analysis,
      campaigns: campaigns.map((c) => ({ ...c, email: emails.find((e) => e.id === c.emailCampaignId) ?? null })),
      automationRuns: Object.fromEntries(enrolled.map((e) => [e.stageId, e._count])),
    };
  }, { timeout: 30_000 });
}

/** Leads currently in (or having reached) a stage, for the stage drawer. */
export async function stageLeads(ctx: AuthContext, id: string, stageId: string, scope: 'CURRENT' | 'REACHED', page: number, pageSize: number) {
  const org = ctx.orgId!;
  return withTenant(org, async (tx) => {
    const f = await tx.funnel.findFirst({ where: { id, organizationId: org } });
    if (!f) throw notFound('Funnel');
    const w = where(org, f, ownerScope(ctx));
    const i = w.stages.findIndex((s) => s.id === stageId);
    if (i < 0) throw notFound('Stage');
    const wh = scope === 'CURRENT' ? w.current(i) : w.reached(i);
    const [total, rows] = await Promise.all([
      tx.clientLead.count({ where: wh }),
      tx.clientLead.findMany({ where: wh, orderBy: [{ score: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * pageSize, take: pageSize, select: { id: true, fullName: true, company: true, status: true, score: true, dealValue: true, currency: true, lastActivityAt: true, owner: { select: { name: true } }, stage: { select: { name: true } } } }),
    ]);
    return { total, rows: rows.map((r) => ({ ...r, dealValue: r.dealValue == null ? null : Number(r.dealValue) })) };
  });
}

/** Leads currently in a stage that an automation has not yet acted on. */
async function newArrivals(tx: Tx, f: Funnel, stageIndex: number, limit: number) {
  const w = where(f.organizationId, f, null);
  const stage = w.stages[stageIndex];
  return tx.clientLead.findMany({
    where: { AND: [w.current(stageIndex), { NOT: { id: { in: (await tx.funnelEnrollment.findMany({ where: { funnelId: f.id, stageId: stage.id }, select: { clientLeadId: true } })).map((e) => e.clientLeadId) } } }] },
    select: { id: true, ownerId: true, fullName: true }, take: limit, orderBy: { createdAt: 'asc' },
  });
}

export async function saveFunnel(ctx: AuthContext, id: string | null, input: FunnelInput) {
  const org = ctx.orgId!;
  return withTenant(org, async (tx) => {
    const data = { name: input.name, description: input.description ?? null, goal: input.goal ?? null, status: input.status, baseFilter: input.baseFilter as unknown as Prisma.InputJsonValue, stages: input.stages as unknown as Prisma.InputJsonValue };
    let f: Funnel;
    let before: Funnel | null = null;
    if (id) {
      before = await tx.funnel.findFirst({ where: { id, organizationId: org } });
      if (!before) throw notFound('Funnel');
      f = await tx.funnel.update({ where: { id }, data });
    } else {
      f = await tx.funnel.create({ data: { ...data, organizationId: org, createdById: ctx.user.id } });
    }
    // Newly switched-on "only new arrivals" automations: record everyone already in the stage as a baseline.
    const prev = before ? stagesOf(before) : [];
    const stages = stagesOf(f);
    for (let i = 0; i < stages.length; i++) {
      const a = stages[i].automation;
      const was = prev.find((p) => p.id === stages[i].id)?.automation;
      if (a?.enabled && a.onlyNew && !was?.enabled) {
        const existing = await newArrivals(tx, f, i, 20_000);
        if (existing.length) await tx.funnelEnrollment.createMany({ data: existing.map((l) => ({ organizationId: org, funnelId: f.id, stageId: stages[i].id, clientLeadId: l.id, result: 'baseline' })), skipDuplicates: true });
      }
    }
    await audit(tx, ctx, { action: id ? 'funnel.updated' : 'funnel.created', targetType: 'funnel', targetId: f.id, organizationId: org, after: { name: f.name, stages: stages.map((s) => s.name), status: f.status } });
    return f;
  }, { timeout: 60_000 });
}

export async function deleteFunnel(ctx: AuthContext, id: string) {
  const org = ctx.orgId!;
  return withTenant(org, async (tx) => {
    const f = await tx.funnel.findFirst({ where: { id, organizationId: org } });
    if (!f) throw notFound('Funnel');
    await tx.funnel.update({ where: { id }, data: { status: 'ARCHIVED' } });
    await audit(tx, ctx, { action: 'funnel.archived', targetType: 'funnel', targetId: id, organizationId: org });
  });
}

// ── Templates ──────────────────────────────────────────────────────

const sid = () => randomUUID().slice(0, 8);

export type FunnelTemplate = { key: string; name: string; description: string; goal: string; stages: FunnelStage[]; baseFilter?: { conditions: Condition[] } };

export async function funnelTemplates(ctx: AuthContext): Promise<FunnelTemplate[]> {
  const org = ctx.orgId!;
  const pipeline = await withTenant(org, (tx) => tx.pipeline.findFirst({ where: { organizationId: org, isDefault: true }, include: { stages: { orderBy: { position: 'asc' } } } }));
  const open = pipeline?.stages.filter((s) => s.category !== 'LOST') ?? [];
  const st = (name: string, conditions: Condition[], description?: string): FunnelStage => ({ id: sid(), name, description: description ?? null, conditions, automation: null });
  const templates: FunnelTemplate[] = [
    {
      key: 'sales', name: 'Sales funnel', description: 'From new lead to won deal, by lead status.', goal: 'Convert new leads into customers',
      stages: [
        st('All leads', [], 'Every active lead — leads lost early stay here'),
        st('Contacted', [{ field: 'status', op: 'in', value: ['CONTACTED', 'QUALIFIED', 'NEGOTIATION', 'CONVERTED'] }]),
        st('Qualified', [{ field: 'status', op: 'in', value: ['QUALIFIED', 'NEGOTIATION', 'CONVERTED'] }]),
        st('Negotiation', [{ field: 'status', op: 'in', value: ['NEGOTIATION', 'CONVERTED'] }]),
        st('Won', [{ field: 'status', op: 'in', value: ['CONVERTED'] }]),
      ],
    },
    ...(open.length >= 2 ? [{
      key: 'pipeline', name: `${pipeline!.name} funnel`, description: 'Mirrors your pipeline stages in order.', goal: 'Move deals through the pipeline',
      stages: open.map((s, i) => st(s.name, i === 0 ? [] : [{ field: 'stageId', op: 'in', value: open.slice(i).map((x) => x.id) }])),
    }] : []),
    {
      key: 'engagement', name: 'Engagement funnel', description: 'Are new leads being worked quickly and kept warm?', goal: 'Contact every lead and keep them active',
      stages: [
        st('Received', []),
        st('First contact made', [{ field: 'firstContactAt', op: 'not_empty' }]),
        st('Active in last 14 days', [{ field: 'firstContactAt', op: 'not_empty' }, { field: 'lastActivityAt', op: 'last_days', value: 14 }]),
        st('Converted', [{ field: 'status', op: 'in', value: ['CONVERTED'] }]),
      ],
    },
    {
      key: 'nurture', name: 'New-lead nurture', description: 'Leads allocated in the last 30 days, with a welcome email on arrival.', goal: 'Warm up fresh leads',
      stages: [
        { ...st('Arrived (last 30 days)', []), automation: { enabled: false, action: 'EMAIL', templateId: null, dueInHours: 24, onlyNew: true } },
        st('Contacted', [{ field: 'firstContactAt', op: 'not_empty' }]),
        st('Qualified', [{ field: 'status', op: 'in', value: ['QUALIFIED', 'NEGOTIATION', 'CONVERTED'] }]),
      ],
      baseFilter: { conditions: [{ field: 'createdAt', op: 'last_days', value: 30 }] },
    },
    {
      key: 'hot', name: 'High-score fast track', description: 'Only leads scoring 70+, with a task the moment they arrive.', goal: 'Close hot leads fast',
      stages: [
        { ...st('Hot leads', []), automation: { enabled: false, action: 'TASK', taskTitle: 'Call this hot lead today', dueInHours: 4, onlyNew: true } },
        st('Contacted', [{ field: 'firstContactAt', op: 'not_empty' }]),
        st('Won', [{ field: 'status', op: 'in', value: ['CONVERTED'] }]),
      ],
      baseFilter: { conditions: [{ field: 'score', op: 'gte', value: 70 }] },
    },
  ];
  return templates;
}

// ── Campaigns ──────────────────────────────────────────────────────

export const launchInput = z.object({
  stageId: z.string().max(40),
  scope: z.enum(['CURRENT', 'REACHED']).default('CURRENT'),
  channel: z.enum(['EMAIL', 'TASK', 'NOTIFY']),
  name: z.string().trim().min(2).max(120),
  email: z.object({ smtpAccountId: z.string().max(64), templateId: z.string().max(64), subject: z.string().trim().max(300).optional() }).optional(),
  task: z.object({ title: z.string().trim().min(2).max(200), dueInHours: z.number().int().min(0).max(720).default(24) }).optional(),
  notify: z.object({ message: z.string().trim().min(2).max(300) }).optional(),
});

export async function launchFunnelCampaign(ctx: AuthContext, id: string, input: z.infer<typeof launchInput>) {
  const org = ctx.orgId!;
  const { f, leads, stage } = await withTenant(org, async (tx) => {
    const f = await tx.funnel.findFirst({ where: { id, organizationId: org } });
    if (!f) throw notFound('Funnel');
    const w = where(org, f, ownerScope(ctx));
    const i = w.stages.findIndex((s) => s.id === input.stageId);
    if (i < 0) throw notFound('Stage');
    const leads = await tx.clientLead.findMany({ where: input.scope === 'CURRENT' ? w.current(i) : w.reached(i), select: { id: true, ownerId: true, fullName: true }, take: 5001 });
    return { f, leads, stage: w.stages[i] };
  });
  if (!leads.length) throw new AppError('VALIDATION_FAILED', 'No leads are in this stage right now');
  if (leads.length > 5000) throw new AppError('VALIDATION_FAILED', 'Campaigns are limited to 5,000 leads. Narrow the funnel with a base filter.');

  let emailCampaignId: string | null = null;
  let recipients = leads.length;
  let skipped = 0;
  if (input.channel === 'EMAIL') {
    if (!can(ctx, 'crm.email.send')) throw new AppError('FORBIDDEN', 'You do not have permission to send email');
    if (!input.email) throw new AppError('VALIDATION_FAILED', 'Choose a sender and a template');
    const tpl = await withPlatform((tx) => tx.emailTemplate.findFirst({ where: { id: input.email!.templateId, archivedAt: null, OR: [{ organizationId: org }, { organizationId: null }] } }));
    if (!tpl) throw notFound('Template');
    const c = await createCampaign(ctx, {
      name: `${f.name} · ${stage.name} · ${input.name}`, smtpAccountId: input.email.smtpAccountId, templateId: tpl.id, subject: input.email.subject || tpl.subject, preheader: tpl.preheader,
      design: tpl.design as never, audience: { kind: 'workspace', ids: leads.map((l) => l.id) }, trackOpens: true, confirmLarge: true,
    });
    emailCampaignId = c.id;
    recipients = c.totalRecipients - c.skippedCount;
    skipped = c.skippedCount;
  }
  return withTenant(org, async (tx) => {
    if (input.channel === 'TASK') {
      if (!input.task) throw new AppError('VALIDATION_FAILED', 'Enter a task title');
      const due = new Date(Date.now() + input.task.dueInHours * 3600_000);
      await tx.task.createMany({ data: leads.map((l) => ({ organizationId: org, clientLeadId: l.id, title: input.task!.title, type: 'FOLLOW_UP' as const, priority: 'HIGH' as const, dueAt: due, assigneeId: l.ownerId ?? ctx.user.id, createdById: ctx.user.id })) });
    }
    if (input.channel === 'NOTIFY') {
      if (!input.notify) throw new AppError('VALIDATION_FAILED', 'Enter a message');
      const byOwner = new Map<string, number>();
      for (const l of leads) byOwner.set(l.ownerId ?? ctx.user.id, (byOwner.get(l.ownerId ?? ctx.user.id) ?? 0) + 1);
      for (const [userId, n] of byOwner) await notifyUsers([userId], { type: 'FUNNEL', title: `${f.name} · ${stage.name}: ${n} lead${n === 1 ? '' : 's'}`, body: input.notify.message, link: `/app/funnels/${f.id}`, organizationId: org }, tx);
    }
    const fc = await tx.funnelCampaign.create({ data: { organizationId: org, funnelId: f.id, stageId: stage.id, stageName: stage.name, scope: input.scope, channel: input.channel, name: input.name, emailCampaignId, recipients, skipped, createdById: ctx.user.id, details: (input.channel === 'TASK' ? input.task : input.channel === 'NOTIFY' ? input.notify : { templateId: input.email?.templateId }) as Prisma.InputJsonValue } });
    await audit(tx, ctx, { action: 'funnel.campaign.launched', targetType: 'funnel', targetId: f.id, organizationId: org, metadata: { stage: stage.name, channel: input.channel, recipients } });
    return fc;
  });
}

/** Counts the audience of a would-be campaign (for the launch dialog). */
export async function audienceSize(ctx: AuthContext, id: string, stageId: string, scope: 'CURRENT' | 'REACHED') {
  const org = ctx.orgId!;
  return withTenant(org, async (tx) => {
    const f = await tx.funnel.findFirst({ where: { id, organizationId: org } });
    if (!f) throw notFound('Funnel');
    const w = where(org, f, ownerScope(ctx));
    const i = w.stages.findIndex((s) => s.id === stageId);
    if (i < 0) throw notFound('Stage');
    const wh = scope === 'CURRENT' ? w.current(i) : w.reached(i);
    const [total, withEmail, owned] = await Promise.all([
      tx.clientLead.count({ where: wh }),
      tx.clientLead.count({ where: { AND: [wh, { NOT: { email: null } }] } }),
      tx.clientLead.count({ where: { AND: [wh, { NOT: { ownerId: null } }] } }),
    ]);
    return { total, withEmail, owned };
  });
}

// ── Stage automations (worker) ─────────────────────────────────────

export async function runFunnelAutomations() {
  const funnels = await withPlatform((tx) => tx.funnel.findMany({ where: { status: 'ACTIVE' } }));
  let acted = 0;
  for (const f of funnels) {
    const stages = stagesOf(f);
    for (let i = 0; i < stages.length; i++) {
      const a = stages[i].automation;
      if (!a?.enabled) continue;
      try {
        const campaigns = new Set<string>();
        const done = await withPlatform(async (tx) => {
          const fresh = await newArrivals(tx, f, i, 200);
          if (!fresh.length) return 0;
          await tx.funnelEnrollment.createMany({ data: fresh.map((l) => ({ organizationId: f.organizationId, funnelId: f.id, stageId: stages[i].id, clientLeadId: l.id, result: a.action })), skipDuplicates: true });
          if (a.action === 'EMAIL' && a.templateId) {
            for (const l of fresh) {
              const r = await queueAutomationEmail(tx, { organizationId: f.organizationId, clientLeadId: l.id, templateId: a.templateId, workflowId: `funnel:${f.id}:${stages[i].id}`, workflowName: `${f.name} · ${stages[i].name}`, actorId: f.createdById });
              if (r.campaignId) campaigns.add(r.campaignId);
            }
          }
          if (a.action === 'TASK') {
            await tx.task.createMany({ data: fresh.map((l) => ({ organizationId: f.organizationId, clientLeadId: l.id, title: a.taskTitle || `Follow up: entered ${stages[i].name}`, type: 'FOLLOW_UP' as const, priority: 'HIGH' as const, dueAt: new Date(Date.now() + a.dueInHours * 3600_000), assigneeId: l.ownerId ?? f.createdById, createdById: f.createdById })) });
          }
          if (a.action === 'NOTIFY') {
            const byOwner = new Map<string, number>();
            for (const l of fresh) byOwner.set(l.ownerId ?? f.createdById, (byOwner.get(l.ownerId ?? f.createdById) ?? 0) + 1);
            for (const [userId, n] of byOwner) await notifyUsers([userId], { type: 'FUNNEL', title: `${n} lead${n === 1 ? '' : 's'} entered ${stages[i].name} (${f.name})`, body: a.message ?? undefined, link: `/app/funnels/${f.id}`, organizationId: f.organizationId }, tx);
          }
          await tx.funnelCampaign.create({ data: { organizationId: f.organizationId, funnelId: f.id, stageId: stages[i].id, stageName: stages[i].name, scope: 'CURRENT', channel: a.action, name: 'Stage automation', automated: true, recipients: fresh.length, emailCampaignId: [...campaigns][0] ?? null, createdById: f.createdById } });
          return fresh.length;
        }, { timeout: 60_000 });
        for (const c of campaigns) await startCampaign(c).catch(() => null);
        acted += done;
      } catch (err) {
        logger.error({ err, funnel: f.id, stage: stages[i].id }, 'funnel automation failed');
      }
    }
  }
  return { acted };
}

/** Analysis of an unsaved funnel definition — powers the builder's live counts. */
export async function previewFunnel(ctx: AuthContext, input: Pick<FunnelInput, 'stages' | 'baseFilter'>) {
  const org = ctx.orgId!;
  return withTenant(org, (tx) => analyzeFunnel(tx, org, { stages: input.stages as unknown as Prisma.JsonValue, baseFilter: input.baseFilter as unknown as Prisma.JsonValue }, ownerScope(ctx)), { timeout: 30_000 });
}
