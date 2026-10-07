import type { Prisma, WorkflowDefinition } from '@prisma/client';
import { z } from 'zod';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { withPlatform, type Tx } from '../db';
import { AppError, notFound } from '../errors';
import { logger } from '../logger';
import { raiseAlert } from '../security/alerts';
import { ACTIVITY, recordActivity } from './activity';
import { queueAutomationEmail, startCampaign } from './email';
import { notifyPermission, notifyUsers } from './notifications';

export { runScheduledReports } from './reports';

/**
 * Workflow engine. A workflow is a graph drawn on the canvas: one trigger, then conditions (yes / no
 * branches), actions and waits. Triggers are evaluated by a durable scan (every 5 minutes from the
 * worker). Each (workflow version × subject × occurrence) produces at most one execution, enforced by a
 * unique dedupe key. A wait pauses the execution until a later scan, which first re-checks that the
 * trigger still holds (so resolved situations stop escalating).
 */
export const TRIGGERS = {
  LEAD_ARRIVED: 'A new lead arrives in a workspace',
  LEAD_NO_CONTACT: 'Allocated lead has no logged contact attempt',
  LEAD_UNTOUCHED: 'Lead has had no activity',
  TASK_OVERDUE: 'Task is overdue',
  STAGE_STAGNANT: 'Deal has not moved stage',
} as const;
export type Trigger = keyof typeof TRIGGERS;

export const ACTION_TYPES = {
  NOTIFY_OWNER: 'Notify the assigned employee',
  NOTIFY_MANAGERS: 'Notify workspace managers',
  NOTIFY_PLATFORM: 'Flag for platform review',
  SEND_EMAIL: 'Send an email to the lead',
  CREATE_TASK: 'Create a follow-up task',
  SET_PRIORITY: 'Raise priority',
  ADD_TAG: 'Add a tag',
  ESCALATE_TASK: 'Escalate the task',
  FLAG_STALE: 'Record a stale-lead flag',
  DELAY: 'Wait, then continue if still unresolved',
} as const;

export const CONDITION_FIELDS = {
  PRIORITY: { label: 'Priority', kind: 'enum', options: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
  STATUS: { label: 'Lead status', kind: 'enum', options: ['NEW', 'CONTACTED', 'QUALIFIED', 'NEGOTIATION', 'CONVERTED', 'LOST'] },
  HAS_OWNER: { label: 'Has an owner', kind: 'bool' },
  HAS_EMAIL: { label: 'Has an email address', kind: 'bool' },
  HAS_PHONE: { label: 'Has a phone number', kind: 'bool' },
  SCORE: { label: 'Lead score', kind: 'number' },
  SOURCE: { label: 'Lead source', kind: 'text' },
  COUNTRY: { label: 'Country', kind: 'text' },
  TAG: { label: 'Tag', kind: 'text' },
  WEEKDAY: { label: 'Day of the week (UTC)', kind: 'enum', options: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] },
  ORGANIZATION: { label: 'Workspace', kind: 'org' },
} as const;
export type ConditionField = keyof typeof CONDITION_FIELDS;

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('NOTIFY_OWNER'), message: z.string().max(300).optional() }),
  z.object({ type: z.literal('NOTIFY_MANAGERS'), message: z.string().max(300).optional() }),
  z.object({ type: z.literal('NOTIFY_PLATFORM'), message: z.string().max(300).optional() }),
  z.object({ type: z.literal('SEND_EMAIL'), templateId: z.string().min(1, 'Choose an email template').max(64) }),
  z.object({ type: z.literal('CREATE_TASK'), title: z.string().min(2).max(200), dueInHours: z.number().int().min(0).max(720).default(24) }),
  z.object({ type: z.literal('SET_PRIORITY'), priority: z.enum(['HIGH', 'URGENT']) }),
  z.object({ type: z.literal('ADD_TAG'), tag: z.string().trim().min(1, 'Enter a tag').max(40) }),
  z.object({ type: z.literal('ESCALATE_TASK') }),
  z.object({ type: z.literal('FLAG_STALE') }),
  z.object({ type: z.literal('DELAY'), hours: z.number().min(0.1).max(720) }),
]);
export type Action = z.infer<typeof actionSchema>;

const triggerConditions = z.object({
  hours: z.number().min(0.1).max(8760).optional(),
  priorities: z.array(z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])).max(4).optional(),
  organizationIds: z.array(z.string().max(64)).max(200).optional(),
});
const triggerEnum = z.enum(Object.keys(TRIGGERS) as [Trigger, ...Trigger[]]);

// ── Graph ──────────────────────────────────────────────────────────

const nodeId = z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/);
const position = z.object({ x: z.number().finite().min(-100_000).max(100_000), y: z.number().finite().min(-100_000).max(100_000) });
const conditionData = z.object({
  field: z.enum(Object.keys(CONDITION_FIELDS) as [ConditionField, ...ConditionField[]]),
  op: z.enum(['is', 'is_not', 'contains', 'gte', 'lte', 'is_true', 'is_false']),
  value: z.union([z.string().max(200), z.number().finite(), z.array(z.string().max(64)).max(50)]).optional(),
});
export type ConditionData = z.infer<typeof conditionData>;

const graphNode = z.discriminatedUnion('type', [
  z.object({ id: nodeId, type: z.literal('trigger'), position, data: triggerConditions.extend({ trigger: triggerEnum }) }),
  z.object({ id: nodeId, type: z.literal('condition'), position, data: conditionData }),
  z.object({ id: nodeId, type: z.literal('action'), position, data: actionSchema.refine((a) => a.type !== 'DELAY', 'Use a Wait step for delays') }),
  z.object({ id: nodeId, type: z.literal('delay'), position, data: z.object({ hours: z.number().min(0.1, 'Wait at least a few minutes').max(720, 'Waits are limited to 30 days') }) }),
  z.object({ id: nodeId, type: z.literal('note'), position, data: z.object({ text: z.string().max(500) }) }),
]);
const graphEdge = z.object({ id: z.string().min(1).max(100), source: nodeId, target: nodeId, sourceHandle: z.enum(['next', 'yes', 'no']).default('next') });

export const graphSchema = z
  .object({ nodes: z.array(graphNode).min(1).max(80), edges: z.array(graphEdge).max(200) })
  .superRefine((g, ctx) => {
    for (const p of graphProblems(g)) ctx.addIssue({ code: 'custom', message: p });
  });
export type Graph = z.infer<typeof graphSchema>;
type GraphNode = Graph['nodes'][number];

/** Plain-language structural problems. Shared by the API and (mirrored) by the canvas UI. */
export function graphProblems(g: { nodes: { id: string; type: string }[]; edges: { source: string; target: string; sourceHandle?: string }[] }): string[] {
  const out: string[] = [];
  const ids = new Map(g.nodes.map((n) => [n.id, n]));
  if (ids.size !== g.nodes.length) out.push('Two steps share the same id');
  const triggers = g.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) out.push('A workflow needs exactly one “When” trigger');
  const used = new Set<string>();
  for (const e of g.edges) {
    const s = ids.get(e.source);
    const t = ids.get(e.target);
    if (!s || !t) { out.push('A connection points to a step that no longer exists'); continue; }
    const h = e.sourceHandle ?? 'next';
    if (s.type === 'note' || t.type === 'note') out.push('Notes cannot be connected');
    if (t.type === 'trigger') out.push('Nothing can lead into the “When” trigger');
    if (s.type === 'condition' ? h === 'next' : h !== 'next') out.push('A connection uses the wrong output');
    const key = `${e.source}:${h}`;
    if (used.has(key)) out.push('A step output is connected to more than one next step');
    used.add(key);
    if (e.source === e.target) out.push('A step cannot connect to itself');
  }
  // Cycles would make a workflow run forever.
  const adj = new Map<string, string[]>();
  for (const e of g.edges) adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    state.set(id, 1);
    for (const n of adj.get(id) ?? []) {
      if (state.get(n) === 1) return true;
      if (!state.has(n) && visit(n)) return true;
    }
    state.set(id, 2);
    return false;
  };
  if (g.nodes.some((n) => !state.has(n.id) && visit(n.id))) out.push('Steps are connected in a loop — workflows must always move forward');
  if (triggers.length === 1 && !g.edges.some((e) => e.source === triggers[0].id)) out.push('Connect at least one step after the “When” trigger');
  return [...new Set(out)];
}

/** Converts a pre-canvas linear workflow (trigger + ordered actions) into an equivalent graph. */
export function legacyToGraph(trigger: string, conditions: unknown, actions: unknown): Graph {
  const c = triggerConditions.parse(conditions ?? {});
  const list = z.array(actionSchema).parse(actions ?? []);
  const nodes: GraphNode[] = [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { ...c, trigger: trigger as Trigger } }];
  const edges: Graph['edges'] = [];
  list.forEach((a, i) => {
    const id = `a${i}`;
    nodes.push(a.type === 'DELAY' ? { id, type: 'delay', position: { x: 0, y: 150 * (i + 1) }, data: { hours: a.hours } } : { id, type: 'action', position: { x: 0, y: 150 * (i + 1) }, data: a });
    edges.push({ id: `e${i}`, source: i === 0 ? 'trigger' : `a${i - 1}`, target: id, sourceHandle: 'next' });
  });
  return { nodes, edges };
}

export function graphOf(wf: Pick<WorkflowDefinition, 'graph' | 'trigger' | 'conditions' | 'actions'>): Graph {
  if (wf.graph) return wf.graph as unknown as Graph;
  return legacyToGraph(wf.trigger, wf.conditions, wf.actions);
}

const triggerOf = (g: Graph) => g.nodes.find((n): n is Extract<GraphNode, { type: 'trigger' }> => n.type === 'trigger')!;
const nextOf = (g: Graph, id: string, handle: 'next' | 'yes' | 'no' = 'next') => g.edges.find((e) => e.source === id && (e.sourceHandle ?? 'next') === handle)?.target ?? null;

// ── Input ──────────────────────────────────────────────────────────

export const workflowInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).nullable().optional(),
    graph: graphSchema.optional(),
    // Linear form, still accepted for API compatibility. Converted to a graph on save.
    trigger: triggerEnum.optional(),
    conditions: triggerConditions.optional(),
    actions: z.array(actionSchema).min(1).max(12).optional(),
    enabled: z.boolean(),
    testMode: z.boolean(),
    maxAttempts: z.number().int().min(1).max(10).default(3),
  })
  .refine((w) => w.graph || (w.trigger && w.actions), 'Provide a workflow graph (or a trigger and actions)');
export type WorkflowInput = z.infer<typeof workflowInput>;

function normalizeInput(input: WorkflowInput) {
  const graph = input.graph ?? legacyToGraph(input.trigger!, input.conditions ?? {}, input.actions!);
  const t = triggerOf(graph);
  const { trigger, ...conditions } = t.data;
  return { name: input.name, description: input.description ?? null, enabled: input.enabled, testMode: input.testMode, maxAttempts: input.maxAttempts, trigger, conditions, graph };
}

// ── Execution ──────────────────────────────────────────────────────

type Subject = { id: string; organizationId: string; clientLeadId: string | null; ownerId: string | null; title: string; occurrence: string; link: string };
type Effects = (() => Promise<void>)[];

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

/** Finds subjects currently matching a workflow's trigger. Bounded per scan. */
async function findSubjects(tx: Tx, wf: Pick<WorkflowDefinition, 'organizationId' | 'trigger' | 'conditions'>, limit = 500, onlyIds?: string[]): Promise<Subject[]> {
  const c = triggerConditions.parse(wf.conditions);
  const orgFilter = wf.organizationId ? [wf.organizationId] : c.organizationIds?.length ? c.organizationIds : undefined;
  const orgWhere = orgFilter ? { organizationId: { in: orgFilter } } : {};
  const prio = c.priorities?.length ? { priority: { in: c.priorities } } : {};
  const ids = onlyIds ? { id: { in: onlyIds } } : {};
  const base = { revokedAt: null, archivedAt: null, organization: { status: 'ACTIVE' as const } };
  switch (wf.trigger as Trigger) {
    case 'LEAD_ARRIVED': {
      // When resuming after a wait (onlyIds), the arrival window no longer applies.
      const rows = await tx.clientLead.findMany({
        where: { ...base, ...orgWhere, ...prio, ...ids, ...(onlyIds ? {} : { createdAt: { gte: hoursAgo(c.hours ?? 1) } }) },
        select: { id: true, organizationId: true, ownerId: true, fullName: true, assignmentId: true },
        take: limit, orderBy: { createdAt: 'asc' },
      });
      return rows.map((r) => ({ id: r.id, organizationId: r.organizationId, clientLeadId: r.id, ownerId: r.ownerId, title: r.fullName, occurrence: r.assignmentId, link: `/app/leads/${r.id}` }));
    }
    case 'LEAD_NO_CONTACT': {
      const rows = await tx.clientLead.findMany({
        where: { ...base, ...orgWhere, ...prio, ...ids, firstContactAt: null, status: { notIn: ['CONVERTED', 'LOST'] }, createdAt: { lt: hoursAgo(c.hours ?? 24) } },
        select: { id: true, organizationId: true, ownerId: true, fullName: true, assignmentId: true },
        take: limit, orderBy: { createdAt: 'asc' },
      });
      return rows.map((r) => ({ id: r.id, organizationId: r.organizationId, clientLeadId: r.id, ownerId: r.ownerId, title: r.fullName, occurrence: r.assignmentId, link: `/app/leads/${r.id}` }));
    }
    case 'LEAD_UNTOUCHED': {
      const cutoff = hoursAgo(c.hours ?? 24 * 7);
      const rows = await tx.clientLead.findMany({
        where: { ...base, ...orgWhere, ...prio, ...ids, status: { notIn: ['CONVERTED', 'LOST'] }, OR: [{ lastActivityAt: { lt: cutoff } }, { lastActivityAt: null, createdAt: { lt: cutoff } }] },
        select: { id: true, organizationId: true, ownerId: true, fullName: true, lastActivityAt: true, createdAt: true },
        take: limit, orderBy: { lastActivityAt: { sort: 'asc', nulls: 'first' } },
      });
      return rows.map((r) => ({ id: r.id, organizationId: r.organizationId, clientLeadId: r.id, ownerId: r.ownerId, title: r.fullName, occurrence: (r.lastActivityAt ?? r.createdAt).toISOString(), link: `/app/leads/${r.id}` }));
    }
    case 'TASK_OVERDUE': {
      const rows = await tx.task.findMany({
        where: { ...orgWhere, ...prio, ...ids, status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { lt: hoursAgo(c.hours ?? 0) } },
        select: { id: true, organizationId: true, assigneeId: true, title: true, clientLeadId: true, dueAt: true },
        take: limit, orderBy: { dueAt: 'asc' },
      });
      return rows.map((r) => ({ id: r.id, organizationId: r.organizationId, clientLeadId: r.clientLeadId, ownerId: r.assigneeId, title: r.title, occurrence: r.dueAt!.toISOString(), link: '/app/tasks' }));
    }
    case 'STAGE_STAGNANT': {
      const rows = await tx.clientLead.findMany({
        where: { ...base, ...orgWhere, ...prio, ...ids, stage: { category: 'OPEN' }, stageEnteredAt: { not: null } },
        select: { id: true, organizationId: true, ownerId: true, fullName: true, stageEnteredAt: true, stage: { select: { name: true, stagnantAfterDays: true } } },
        take: limit * 4, orderBy: { stageEnteredAt: 'asc' },
      });
      return rows
        .filter((r) => {
          const days = c.hours ? c.hours / 24 : r.stage?.stagnantAfterDays;
          return days != null && r.stageEnteredAt!.getTime() < Date.now() - days * 86400_000;
        })
        .slice(0, limit)
        .map((r) => ({ id: r.id, organizationId: r.organizationId, clientLeadId: r.id, ownerId: r.ownerId, title: `${r.fullName} · ${r.stage?.name}`, occurrence: r.stageEnteredAt!.toISOString(), link: '/app/pipeline' }));
    }
  }
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const asList = (v: unknown) => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]);

/** Evaluates a condition against live data. Missing data evaluates to "no". */
export async function evaluateCondition(tx: Tx, s: Pick<Subject, 'organizationId' | 'clientLeadId' | 'ownerId'>, c: ConditionData, now = new Date()): Promise<boolean> {
  const negate = c.op === 'is_not' || c.op === 'is_false';
  const verdict = (b: boolean) => (negate ? !b : b);
  switch (c.field) {
    case 'WEEKDAY':
      return verdict(asList(c.value).includes(WEEKDAYS[now.getUTCDay()]));
    case 'ORGANIZATION':
      return verdict(asList(c.value).includes(s.organizationId));
    case 'HAS_OWNER':
      return verdict(Boolean(s.ownerId));
  }
  if (!s.clientLeadId) return false;
  const cl = await tx.clientLead.findUnique({
    where: { id: s.clientLeadId },
    select: { priority: true, status: true, score: true, source: true, country: true, email: true, phone: true, tags: { select: { tag: { select: { name: true } } } } },
  });
  if (!cl) return false;
  const text = (v: string | null) => {
    const hay = (v ?? '').trim().toLowerCase();
    const needles = asList(c.value).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!needles.length) return false;
    return c.op === 'contains' ? needles.some((n) => hay.includes(n)) : verdict(needles.includes(hay));
  };
  switch (c.field) {
    case 'PRIORITY':
      return verdict(asList(c.value).includes(cl.priority));
    case 'STATUS':
      return verdict(asList(c.value).includes(cl.status));
    case 'HAS_EMAIL':
      return verdict(Boolean(cl.email?.trim()));
    case 'HAS_PHONE':
      return verdict(Boolean(cl.phone?.trim()));
    case 'SCORE': {
      const n = Number(Array.isArray(c.value) ? c.value[0] : c.value);
      if (!Number.isFinite(n)) return false;
      return c.op === 'lte' ? cl.score <= n : c.op === 'gte' ? cl.score >= n : verdict(cl.score === n);
    }
    case 'SOURCE':
      return text(cl.source);
    case 'COUNTRY':
      return text(cl.country);
    case 'TAG': {
      const want = asList(c.value).map((x) => x.trim().toLowerCase());
      const has = cl.tags.some((t) => want.includes(t.tag.name.toLowerCase()));
      return verdict(has);
    }
  }
  return false;
}

async function runAction(tx: Tx, wf: WorkflowDefinition, s: Subject, a: Action, test: boolean, effects: Effects): Promise<string> {
  const msg = (fallback: string, m?: string) => m || fallback;
  switch (a.type) {
    case 'NOTIFY_OWNER': {
      if (!s.ownerId) {
        if (test) return 'would notify managers (lead has no owner)';
        await notifyPermission('crm.leads.assign', s.organizationId, { type: 'WORKFLOW', title: msg(`${wf.name}: ${s.title} has no owner`, a.message), link: s.link, dedupeKey: `wf:${wf.id}:${s.id}:${s.occurrence}:owner` }, tx);
        return 'notified managers (no owner)';
      }
      if (test) return 'would notify the owner';
      await notifyUsers([s.ownerId], { type: 'WORKFLOW', title: msg(`${wf.name}: ${s.title}`, a.message), link: s.link, organizationId: s.organizationId, dedupeKey: `wf:${wf.id}:${s.id}:${s.occurrence}:owner` }, tx);
      return 'notified owner';
    }
    case 'NOTIFY_MANAGERS': {
      if (test) return 'would notify managers';
      const n = await notifyPermission('crm.team.manage', s.organizationId, { type: 'WORKFLOW', title: msg(`Escalation — ${wf.name}: ${s.title}`, a.message), link: s.link, dedupeKey: `wf:${wf.id}:${s.id}:${s.occurrence}:mgr` }, tx);
      return `notified ${n} manager(s)`;
    }
    case 'NOTIFY_PLATFORM': {
      if (test) return 'would flag for platform review';
      const org = await tx.organization.findUnique({ where: { id: s.organizationId }, select: { name: true } });
      const n = await notifyPermission('distribution.reassign', null, { type: 'WORKFLOW_REVIEW', title: msg(`Review: ${s.title} (${org?.name}) — ${wf.name}`, a.message), link: s.clientLeadId ? `/admin/leads?review=${s.clientLeadId}` : '/admin/leads', dedupeKey: `wf:${wf.id}:${s.id}:${s.occurrence}:platform` }, tx);
      return `flagged to ${n} platform user(s)`;
    }
    case 'SEND_EMAIL': {
      if (!s.clientLeadId) return 'skipped (no lead)';
      if (test) {
        const t = await tx.emailTemplate.findUnique({ where: { id: a.templateId }, select: { name: true } });
        return `would email “${t?.name ?? 'missing template'}”`;
      }
      const r = await queueAutomationEmail(tx, { organizationId: s.organizationId, clientLeadId: s.clientLeadId, templateId: a.templateId, workflowId: wf.id, workflowName: wf.name, actorId: wf.createdById });
      if (r.campaignId) {
        const id = r.campaignId;
        effects.push(() => startCampaign(id));
      }
      return r.result;
    }
    case 'CREATE_TASK': {
      if (test) return `would create task “${a.title}”`;
      await tx.task.create({ data: { organizationId: s.organizationId, clientLeadId: s.clientLeadId, title: a.title, type: 'FOLLOW_UP', priority: 'HIGH', dueAt: new Date(Date.now() + a.dueInHours * 3600_000), assigneeId: s.ownerId, createdById: wf.createdById } });
      return 'created task';
    }
    case 'SET_PRIORITY': {
      if (!s.clientLeadId) return 'skipped (no lead)';
      if (test) return `would set priority ${a.priority}`;
      await tx.clientLead.update({ where: { id: s.clientLeadId }, data: { priority: a.priority } });
      return `priority → ${a.priority}`;
    }
    case 'ADD_TAG': {
      if (!s.clientLeadId) return 'skipped (no lead)';
      if (test) return `would tag “${a.tag}”`;
      const tag = await tx.tag.upsert({ where: { organizationId_name: { organizationId: s.organizationId, name: a.tag } }, create: { organizationId: s.organizationId, name: a.tag }, update: {} });
      await tx.clientLeadTag.upsert({ where: { clientLeadId_tagId: { clientLeadId: s.clientLeadId, tagId: tag.id } }, create: { clientLeadId: s.clientLeadId, tagId: tag.id, organizationId: s.organizationId }, update: {} });
      return `tagged “${a.tag}”`;
    }
    case 'ESCALATE_TASK': {
      if (wf.trigger !== 'TASK_OVERDUE') return 'skipped (not a task)';
      if (test) return 'would escalate task';
      await tx.task.update({ where: { id: s.id }, data: { escalatedAt: new Date(), priority: 'URGENT' } });
      await notifyPermission('crm.team.manage', s.organizationId, { type: 'TASK_ESCALATED', title: `Overdue task escalated: ${s.title}`, link: '/app/tasks', dedupeKey: `wf:${wf.id}:${s.id}:${s.occurrence}:esc` }, tx);
      return 'escalated';
    }
    case 'FLAG_STALE': {
      if (!s.clientLeadId) return 'skipped (no lead)';
      if (test) return 'would flag as stale';
      const cl = await tx.clientLead.findUnique({ where: { id: s.clientLeadId }, select: { leadId: true } });
      await recordActivity(tx, { organizationId: s.organizationId, clientLeadId: s.clientLeadId, leadId: cl?.leadId, type: ACTIVITY.STALE_FLAGGED, summary: `Flagged by workflow: ${wf.name}` });
      return 'flagged stale';
    }
    case 'DELAY':
      return 'delay';
  }
}

/**
 * Execution state. `node` is the next step to run (null = finished). `path` records every step
 * visited so the canvas can highlight the route a run took. `step` is the pre-canvas linear cursor.
 */
type ExecState = { node?: string | null; step?: number; path?: string[]; resumeAt?: string; log: string[] };

const MAX_STEPS = 200;

async function advance(tx: Tx, wf: WorkflowDefinition, executionId: string | null, s: Subject, state: ExecState, test: boolean, effects: Effects) {
  const g = graphOf(wf);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  state.path ??= [];
  let cur: string | null;
  if (state.node !== undefined) cur = state.node;
  else if (typeof state.step === 'number' && state.step > 0) cur = byId.has(`a${state.step}`) ? `a${state.step}` : null; // legacy linear cursor
  else cur = nextOf(g, triggerOf(g).id);
  delete state.step;

  for (let guard = 0; cur && guard < MAX_STEPS; guard++) {
    const n = byId.get(cur);
    if (!n) break;
    state.path.push(n.id);
    if (n.type === 'delay') {
      const after = nextOf(g, n.id);
      if (test || !executionId) {
        state.log.push(`would wait ${n.data.hours}h, then re-check`);
        cur = after;
        continue;
      }
      state.node = after;
      state.resumeAt = new Date(Date.now() + n.data.hours * 3600_000).toISOString();
      state.log.push(`waiting ${n.data.hours}h`);
      await tx.workflowExecution.update({ where: { id: executionId }, data: { status: 'RUNNING', result: state as unknown as Prisma.InputJsonValue } });
      return state;
    }
    if (n.type === 'condition') {
      const ok = await evaluateCondition(tx, s, n.data);
      state.log.push(`${conditionLabel(n.data)} → ${ok ? 'yes' : 'no'}`);
      cur = nextOf(g, n.id, ok ? 'yes' : 'no');
      continue;
    }
    if (n.type === 'action') state.log.push(await runAction(tx, wf, s, n.data, test || !executionId, effects));
    cur = nextOf(g, n.id);
  }
  state.node = null;
  delete state.resumeAt;
  if (executionId) await tx.workflowExecution.update({ where: { id: executionId }, data: { status: 'SUCCEEDED', finishedAt: new Date(), result: state as unknown as Prisma.InputJsonValue, error: null } });
  return state;
}

function conditionLabel(c: ConditionData) {
  const f = CONDITION_FIELDS[c.field];
  const v = Array.isArray(c.value) ? c.value.join(', ') : c.value ?? '';
  const op = { is: 'is', is_not: 'is not', contains: 'contains', gte: '≥', lte: '≤', is_true: '', is_false: '(no)' }[c.op];
  return f.kind === 'bool' ? `${f.label}${c.op === 'is_false' ? ' — no' : ''}` : `${f.label} ${op} ${v}`.trim();
}

async function runEffects(effects: Effects) {
  for (const fx of effects) await fx().catch((err) => logger.warn({ err }, 'workflow post-commit effect failed'));
}

/** Scheduled scan: starts new executions for matching subjects and resumes delayed or failed ones. */
export async function runAutomationScan() {
  const workflows = await withPlatform((tx) => tx.workflowDefinition.findMany({ where: { enabled: true } }));
  const summary: Record<string, { started: number; resumed: number; failed: number }> = {};
  for (const wf of workflows) {
    const s = (summary[wf.name] = { started: 0, resumed: 0, failed: 0 });
    let subjects: Subject[] = [];
    try {
      subjects = await withPlatform((tx) => findSubjects(tx, wf));
    } catch (err) {
      logger.error({ err, workflowId: wf.id }, 'workflow trigger evaluation failed');
      continue;
    }
    for (const subj of subjects) {
      const dedupeKey = `${wf.id}:v${wf.version}:${subj.id}:${subj.occurrence}`;
      const effects: Effects = [];
      try {
        await withPlatform(async (tx) => {
          const exists = await tx.workflowExecution.findUnique({ where: { dedupeKey } });
          if (exists) return;
          const ex = await tx.workflowExecution.create({
            data: { workflowId: wf.id, version: wf.version, subjectType: wf.trigger === 'TASK_OVERDUE' ? 'task' : 'client_lead', subjectId: subj.id, dedupeKey, status: 'RUNNING', testMode: wf.testMode, attempts: 1, startedAt: new Date() },
          });
          await advance(tx, wf, ex.id, subj, { log: [] }, wf.testMode, effects);
          s.started++;
        });
        await runEffects(effects);
      } catch (err) {
        s.failed++;
        logger.error({ err, workflowId: wf.id, subject: subj.id }, 'workflow execution failed');
        await withPlatform((tx) => tx.workflowExecution.updateMany({ where: { dedupeKey }, data: { status: 'FAILED', error: String((err as Error).message).slice(0, 500) } })).catch(() => null);
      }
    }
  }

  // Resume delayed executions and retry failed ones.
  const pending = await withPlatform((tx) =>
    tx.workflowExecution.findMany({ where: { OR: [{ status: 'RUNNING' }, { status: 'FAILED' }] }, include: { workflow: true }, take: 500, orderBy: { createdAt: 'asc' } }),
  );
  for (const ex of pending) {
    const wf = ex.workflow;
    const state = ((ex.result as ExecState | null) ?? { log: [] }) as ExecState;
    if (ex.status === 'RUNNING' && state.resumeAt && new Date(state.resumeAt) > new Date()) continue;
    if (ex.status === 'FAILED' && ex.attempts >= wf.maxAttempts) {
      await withPlatform((tx) => tx.workflowExecution.update({ where: { id: ex.id }, data: { status: 'DEAD', finishedAt: new Date() } }));
      await raiseAlert({ type: 'WORKFLOW_DEAD_LETTER', severity: 'LOW', title: `Workflow execution exhausted retries: ${wf.name}`, details: { executionId: ex.id, error: ex.error }, dedupeKey: `wfdead:${ex.id}` });
      continue;
    }
    if (!wf.enabled || ex.version !== wf.version) {
      await withPlatform((tx) => tx.workflowExecution.update({ where: { id: ex.id }, data: { status: 'SKIPPED', finishedAt: new Date(), error: 'Workflow disabled or changed' } }));
      continue;
    }
    const effects: Effects = [];
    try {
      await withPlatform(async (tx) => {
        const [subject] = await findSubjects(tx, wf, 1, [ex.subjectId]);
        if (!subject) {
          state.log.push('condition resolved');
          await tx.workflowExecution.update({ where: { id: ex.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), result: state as unknown as Prisma.InputJsonValue } });
          return;
        }
        await tx.workflowExecution.update({ where: { id: ex.id }, data: { attempts: { increment: ex.status === 'FAILED' ? 1 : 0 }, status: 'RUNNING' } });
        delete state.resumeAt;
        await advance(tx, wf, ex.id, subject, state, ex.testMode, effects);
      });
      await runEffects(effects);
      summary[wf.name] ??= { started: 0, resumed: 0, failed: 0 };
      summary[wf.name].resumed++;
    } catch (err) {
      await withPlatform((tx) => tx.workflowExecution.update({ where: { id: ex.id }, data: { status: 'FAILED', attempts: { increment: 1 }, error: String((err as Error).message).slice(0, 500) } })).catch(() => null);
    }
  }
  return summary;
}

// ── Management ─────────────────────────────────────────────────────

/** JSON with sorted keys: stored graphs come back from jsonb with keys reordered. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export async function upsertWorkflow(ctx: AuthContext, id: string | null, input: WorkflowInput) {
  const data = normalizeInput(input);
  const json = { conditions: data.conditions as Prisma.InputJsonValue, graph: data.graph as unknown as Prisma.InputJsonValue, actions: [] as Prisma.InputJsonValue };
  return withPlatform(async (tx) => {
    if (id) {
      const before = await tx.workflowDefinition.findUnique({ where: { id } });
      if (!before) throw notFound('Workflow');
      // Only behaviour changes create a new version; moving boxes around on the canvas does not.
      const shape = (g: Graph) => stable({ n: g.nodes.filter((n) => n.type !== 'note').map(({ id: i, type, data: d }) => ({ i, type, d })).sort((a, b) => a.i.localeCompare(b.i)), e: g.edges.map((e) => `${e.source}:${e.sourceHandle ?? 'next'}>${e.target}`).sort() });
      const definitionChanged = shape(graphOf(before)) !== shape(data.graph);
      const wf = await tx.workflowDefinition.update({
        where: { id },
        data: { name: data.name, description: data.description, enabled: data.enabled, testMode: data.testMode, maxAttempts: data.maxAttempts, trigger: data.trigger, ...json, version: definitionChanged ? { increment: 1 } : undefined },
      });
      await audit(tx, ctx, { action: 'workflow.updated', targetType: 'workflow', targetId: id, organizationId: null, before: { trigger: before.trigger, enabled: before.enabled, testMode: before.testMode, version: before.version, graph: graphOf(before) }, after: { name: data.name, trigger: data.trigger, enabled: data.enabled, testMode: data.testMode, version: wf.version, graph: data.graph } });
      return wf;
    }
    const wf = await tx.workflowDefinition.create({ data: { name: data.name, description: data.description, enabled: data.enabled, testMode: data.testMode, maxAttempts: data.maxAttempts, trigger: data.trigger, ...json, createdById: ctx.user.id } });
    await audit(tx, ctx, { action: 'workflow.created', targetType: 'workflow', targetId: wf.id, organizationId: null, after: { name: data.name, trigger: data.trigger, enabled: data.enabled, testMode: data.testMode, graph: data.graph } });
    return wf;
  });
}

/**
 * Dry run on live data: lists who matches the trigger right now and, for a sample, walks the graph
 * (conditions evaluated for real, actions and waits simulated) to show the route each would take.
 * Nothing is written.
 */
export async function previewWorkflow(input: WorkflowInput) {
  const data = normalizeInput(input);
  return withPlatform(async (tx) => {
    const fake = { id: 'preview', name: data.name, organizationId: null, trigger: data.trigger, conditions: data.conditions, graph: data.graph, actions: [], createdById: 'preview' } as unknown as WorkflowDefinition;
    const subjects = await findSubjects(tx, fake, 50);
    const orgs = await tx.organization.findMany({ where: { id: { in: [...new Set(subjects.map((s) => s.organizationId))] } }, select: { id: true, name: true } });
    const om = new Map(orgs.map((o) => [o.id, o.name]));
    const sample = [];
    for (const s of subjects.slice(0, 12)) {
      const st = await advance(tx, fake, null, s, { log: [] }, true, []);
      sample.push({ title: s.title, organization: om.get(s.organizationId) ?? '—', hasOwner: Boolean(s.ownerId), path: st.path ?? [], log: st.log });
    }
    return { matches: subjects.length, sample };
  });
}

export async function deleteWorkflow(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const wf = await tx.workflowDefinition.findUnique({ where: { id } });
    if (!wf) throw notFound('Workflow');
    if (wf.enabled) throw new AppError('CONFLICT', 'Turn the workflow off before deleting it');
    await tx.workflowDefinition.delete({ where: { id } });
    await audit(tx, ctx, { action: 'workflow.deleted', targetType: 'workflow', targetId: id, organizationId: null, before: { name: wf.name, trigger: wf.trigger } });
  });
}

export async function getWorkflow(id: string) {
  return withPlatform(async (tx) => {
    const wf = await tx.workflowDefinition.findUnique({ where: { id } });
    if (!wf) throw notFound('Workflow');
    const stats = await tx.workflowExecution.groupBy({ by: ['status'], where: { workflowId: id }, _count: true });
    // Per-step traffic for the current version: how many runs passed through each step.
    const recent = await tx.workflowExecution.findMany({ where: { workflowId: id, version: wf.version }, orderBy: { createdAt: 'desc' }, take: 500, select: { result: true } });
    const traffic: Record<string, number> = {};
    for (const r of recent) for (const n of new Set(((r.result as ExecState | null)?.path ?? []) as string[])) traffic[n] = (traffic[n] ?? 0) + 1;
    return { workflow: { ...wf, graph: graphOf(wf) }, stats: Object.fromEntries(stats.map((s) => [s.status, s._count])), traffic };
  });
}
