/**
 * Client-side model for the workflow canvas: node data shapes, plain-English descriptions, validation
 * (mirrors graphProblems on the server for instant feedback), recipes and an automatic tidy layout.
 */
export type StepType = 'trigger' | 'condition' | 'action' | 'delay' | 'note';
export type Handle = 'next' | 'yes' | 'no';

export type TriggerData = { trigger: string; hours?: number; priorities?: string[]; organizationIds?: string[] };
export type ConditionData = { field: string; op: string; value?: string | number | string[] };
export type ActionData = { type: string; message?: string; templateId?: string; title?: string; dueInHours?: number; priority?: string; tag?: string };
export type DelayData = { hours: number };
export type NoteData = { text: string };
export type StepData = TriggerData | ConditionData | ActionData | DelayData | NoteData;

export type Step = { id: string; type: StepType; position: { x: number; y: number }; data: StepData };
export type Link = { id: string; source: string; target: string; sourceHandle: Handle };
export type Graph = { nodes: Step[]; edges: Link[] };

export type Meta = {
  triggers: Record<string, string>;
  actions: Record<string, string>;
  conditionFields: Record<string, { label: string; kind: 'enum' | 'bool' | 'number' | 'text' | 'org'; options?: string[] }>;
  organizations: { id: string; name: string }[];
  templates: { id: string; name: string; subject: string }[];
};

export const NODE_W = 272;
export const newId = (p = 'n') => `${p}_${Math.random().toString(36).slice(2, 9)}`;

export const TRIGGER_HELP: Record<string, { hoursLabel: string; defaultHours: number; plain: (h: number) => string }> = {
  LEAD_ARRIVED: { hoursLabel: 'Look back (hours)', defaultHours: 1, plain: () => 'a new lead arrives in a workspace' },
  LEAD_NO_CONTACT: { hoursLabel: 'No contact for at least (hours)', defaultHours: 24, plain: (h) => `a lead has had no contact attempt for ${fmtHours(h)}` },
  LEAD_UNTOUCHED: { hoursLabel: 'No activity for at least (hours)', defaultHours: 168, plain: (h) => `a lead has had no activity for ${fmtHours(h)}` },
  TASK_OVERDUE: { hoursLabel: 'Overdue by at least (hours)', defaultHours: 0, plain: (h) => (h ? `a task is overdue by ${fmtHours(h)}` : 'a task becomes overdue') },
  STAGE_STAGNANT: { hoursLabel: 'Stuck for (hours, blank = stage default)', defaultHours: 0, plain: (h) => (h ? `a deal has not moved stage for ${fmtHours(h)}` : 'a deal is stuck past its stage limit') },
};

export function fmtHours(h: number) {
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h % 24 === 0 && h >= 24) return `${h / 24} day${h === 24 ? '' : 's'}`;
  return `${+h.toFixed(1)} hour${h === 1 ? '' : 's'}`;
}

const nice = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const list = (v: unknown) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [String(v)]).map(String);

export const DEFAULT_DATA: Record<string, () => StepData> = {
  trigger: () => ({ trigger: 'LEAD_ARRIVED', hours: 1 }),
  condition: () => ({ field: 'PRIORITY', op: 'is', value: ['HIGH', 'URGENT'] }),
  delay: () => ({ hours: 24 }),
  note: () => ({ text: '' }),
  NOTIFY_OWNER: () => ({ type: 'NOTIFY_OWNER' }),
  NOTIFY_MANAGERS: () => ({ type: 'NOTIFY_MANAGERS' }),
  NOTIFY_PLATFORM: () => ({ type: 'NOTIFY_PLATFORM' }),
  SEND_EMAIL: () => ({ type: 'SEND_EMAIL', templateId: '' }),
  CREATE_TASK: () => ({ type: 'CREATE_TASK', title: 'Follow up', dueInHours: 24 }),
  SET_PRIORITY: () => ({ type: 'SET_PRIORITY', priority: 'HIGH' }),
  ADD_TAG: () => ({ type: 'ADD_TAG', tag: '' }),
  ESCALATE_TASK: () => ({ type: 'ESCALATE_TASK' }),
  FLAG_STALE: () => ({ type: 'FLAG_STALE' }),
};

export const ACTION_HELP: Record<string, string> = {
  NOTIFY_OWNER: 'Sends an in-app notification to the person who owns the lead (or managers if nobody does).',
  NOTIFY_MANAGERS: 'Alerts the workspace’s managers.',
  NOTIFY_PLATFORM: 'Flags the lead for review by your platform team.',
  SEND_EMAIL: 'Emails the lead from the workspace’s own sender using a saved template. Unsubscribes and opt-outs are respected.',
  CREATE_TASK: 'Adds a high-priority follow-up task for the owner.',
  SET_PRIORITY: 'Raises the lead’s priority.',
  ADD_TAG: 'Adds a tag to the lead so it shows up in filters.',
  ESCALATE_TASK: 'Marks an overdue task urgent and alerts managers. Only for “Task is overdue”.',
  FLAG_STALE: 'Records a stale-lead flag on the lead’s timeline.',
};

/** Short title + one-line summary for a step, as shown on the canvas card. */
export function describe(step: Pick<Step, 'type' | 'data'>, meta: Meta): { title: string; summary: string } {
  switch (step.type) {
    case 'trigger': {
      const d = step.data as TriggerData;
      const help = TRIGGER_HELP[d.trigger];
      const bits = [];
      if (d.priorities?.length) bits.push(`priority ${d.priorities.map(nice).join(' / ')}`);
      if (d.organizationIds?.length) bits.push(`${d.organizationIds.length} workspace${d.organizationIds.length === 1 ? '' : 's'}`);
      return { title: meta.triggers[d.trigger] ?? 'Choose a trigger', summary: `${help ? cap(help.plain(d.hours ?? help.defaultHours)) : ''}${bits.length ? ` · only ${bits.join(', ')}` : ''}` };
    }
    case 'condition': {
      const d = step.data as ConditionData;
      return { title: 'Check a condition', summary: conditionSentence(d, meta) };
    }
    case 'delay': {
      const d = step.data as DelayData;
      return { title: `Wait ${fmtHours(d.hours)}`, summary: 'Then continue only if the trigger still applies' };
    }
    case 'note':
      return { title: 'Note', summary: (step.data as NoteData).text };
    case 'action': {
      const d = step.data as ActionData;
      const title = meta.actions[d.type] ?? d.type;
      switch (d.type) {
        case 'SEND_EMAIL': return { title, summary: d.templateId ? `Template: ${meta.templates.find((t) => t.id === d.templateId)?.name ?? 'missing template'}` : 'Choose a template' };
        case 'CREATE_TASK': return { title, summary: `“${d.title || 'Untitled'}” · due in ${fmtHours(d.dueInHours ?? 24)}` };
        case 'SET_PRIORITY': return { title: `Set priority to ${nice(d.priority ?? 'HIGH')}`, summary: 'Moves the lead up the queue' };
        case 'ADD_TAG': return { title, summary: d.tag ? `Tag: ${d.tag}` : 'Enter a tag' };
        case 'NOTIFY_OWNER': case 'NOTIFY_MANAGERS': case 'NOTIFY_PLATFORM': return { title, summary: d.message ? `“${d.message}”` : 'Default message' };
        default: return { title, summary: ACTION_HELP[d.type]?.split('.')[0] ?? '' };
      }
    }
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function conditionSentence(d: ConditionData, meta: Meta) {
  const f = meta.conditionFields[d.field];
  if (!f) return 'Choose what to check';
  const vals = list(d.value);
  if (f.kind === 'bool') return `${f.label}?`;
  const shown = f.kind === 'org' ? vals.map((id) => meta.organizations.find((o) => o.id === id)?.name ?? '?') : f.kind === 'enum' ? vals.map(nice) : vals;
  const op = { is: vals.length > 1 ? 'is any of' : 'is', is_not: vals.length > 1 ? 'is none of' : 'is not', contains: 'contains', gte: 'is at least', lte: 'is at most' }[d.op] ?? d.op;
  return shown.length ? `${f.label} ${op} ${shown.join(', ')}` : `${f.label} — choose a value`;
}

/** Problems with a single step, in plain language. Empty = ready. */
export function stepIssues(step: Step, meta: Meta, trigger?: string): string[] {
  const out: string[] = [];
  if (step.type === 'action') {
    const d = step.data as ActionData;
    if (d.type === 'SEND_EMAIL' && !d.templateId) out.push('Choose an email template');
    if (d.type === 'SEND_EMAIL' && d.templateId && !meta.templates.some((t) => t.id === d.templateId)) out.push('The chosen template no longer exists');
    if (d.type === 'CREATE_TASK' && (d.title ?? '').trim().length < 2) out.push('Give the task a title');
    if (d.type === 'ADD_TAG' && !(d.tag ?? '').trim()) out.push('Enter a tag');
    if (d.type === 'ESCALATE_TASK' && trigger && trigger !== 'TASK_OVERDUE') out.push('Only works with “Task is overdue”');
  }
  if (step.type === 'condition') {
    const d = step.data as ConditionData;
    const f = meta.conditionFields[d.field];
    if (!f) out.push('Choose what to check');
    else if (f.kind !== 'bool' && !list(d.value).filter(Boolean).length) out.push('Choose a value to compare');
  }
  if (step.type === 'delay' && !((step.data as DelayData).hours >= 0.1)) out.push('Set how long to wait');
  return out;
}

/** Whole-graph problems (mirrors the server), plus unreachable-step warnings. */
export function graphIssues(g: Graph, meta: Meta): { problems: { message: string; nodeId?: string }[]; warnings: { message: string; nodeId?: string }[] } {
  const problems: { message: string; nodeId?: string }[] = [];
  const warnings: { message: string; nodeId?: string }[] = [];
  const triggers = g.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) problems.push({ message: 'Add exactly one “When” trigger' });
  const trigger = triggers[0];
  if (trigger && !g.edges.some((e) => e.source === trigger.id)) problems.push({ message: 'Connect a step after the trigger', nodeId: trigger.id });
  const used = new Set<string>();
  for (const e of g.edges) {
    const k = `${e.source}:${e.sourceHandle}`;
    if (used.has(k)) problems.push({ message: 'An output connects to two steps — keep one', nodeId: e.source });
    used.add(k);
  }
  const adj = new Map<string, string[]>();
  for (const e of g.edges) adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  const state = new Map<string, number>();
  const loop = (id: string): boolean => {
    state.set(id, 1);
    for (const n of adj.get(id) ?? []) {
      if (state.get(n) === 1 || (!state.has(n) && loop(n))) return true;
    }
    state.set(id, 2);
    return false;
  };
  if (g.nodes.some((n) => !state.has(n.id) && loop(n.id))) problems.push({ message: 'Steps are connected in a loop' });
  const t = (trigger?.data as TriggerData | undefined)?.trigger;
  for (const n of g.nodes) for (const m of stepIssues(n, meta, t)) problems.push({ message: `${describe(n, meta).title}: ${m}`, nodeId: n.id });
  // Reachability: steps not connected to the trigger never run.
  const seen = new Set<string>();
  const walk = (id: string) => { if (seen.has(id)) return; seen.add(id); for (const n of adj.get(id) ?? []) walk(n); };
  if (trigger) walk(trigger.id);
  for (const n of g.nodes) if (n.type !== 'note' && n.type !== 'trigger' && !seen.has(n.id)) warnings.push({ message: `“${describe(n, meta).title}” isn’t connected, so it will never run`, nodeId: n.id });
  return { problems, warnings };
}

/** Reads the flow top-down as numbered plain-English sentences (for the summary panel). */
export function narrate(g: Graph, meta: Meta): string[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const next = (id: string, h: Handle) => g.edges.find((e) => e.source === id && e.sourceHandle === h)?.target;
  const trigger = g.nodes.find((n) => n.type === 'trigger');
  if (!trigger) return [];
  const td = trigger.data as TriggerData;
  const lines = [`When ${TRIGGER_HELP[td.trigger]?.plain(td.hours ?? TRIGGER_HELP[td.trigger].defaultHours) ?? 'the trigger fires'}${td.priorities?.length ? ` (priority ${td.priorities.map(nice).join('/')})` : ''}:`];
  const seen = new Set<string>();
  const walk = (id: string | undefined, depth: number) => {
    for (let guard = 0; id && guard < 100; guard++) {
      const n = byId.get(id);
      if (!n || seen.has(id)) return;
      seen.add(id);
      const pad = '  '.repeat(depth);
      if (n.type === 'condition') {
        const cond = conditionSentence(n.data as ConditionData, meta).replace(/\?$/, '');
        lines.push(`${pad}If ${cond.charAt(0).toLowerCase()}${cond.slice(1)}:`);
        lines.push(`${pad}  → Yes:`);
        walk(next(n.id, 'yes'), depth + 2);
        lines.push(`${pad}  → No:`);
        walk(next(n.id, 'no'), depth + 2);
        return;
      }
      const d = describe(n, meta);
      lines.push(`${pad}• ${d.title}${n.type === 'action' && d.summary && !d.summary.startsWith('Default') ? ` — ${d.summary}` : ''}`);
      id = next(n.id, 'next');
    }
    if (!id) lines.push(`${'  '.repeat(depth)}• Done`);
  };
  walk(next(trigger.id, 'next'), 1);
  return lines;
}

/**
 * Tidy layout: a top-down tree from the trigger. Each branch gets its own column span; "yes" goes left,
 * "no" right. Steps reached twice keep their first position. Unconnected steps line up on the right.
 */
export function tidy(g: Graph): Graph {
  const GAP_X = 48;
  const GAP_Y = 168;
  const pos = new Map<string, { x: number; y: number }>();
  const kids = (id: string) => {
    const hs: Handle[] = ['yes', 'no', 'next'];
    return hs.map((h) => g.edges.find((e) => e.source === id && e.sourceHandle === h)?.target).filter(Boolean) as string[];
  };
  const placed = new Set<string>();
  const width = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const ks = kids(id).filter((k) => !seen.has(k));
    if (!ks.length) return NODE_W;
    return Math.max(NODE_W, ks.reduce((sum, k, i) => sum + width(k, seen) + (i ? GAP_X : 0), 0));
  };
  const place = (id: string, x0: number, depth: number) => {
    if (placed.has(id)) return;
    placed.add(id);
    const ks = kids(id).filter((k) => !placed.has(k));
    const w = width(id);
    pos.set(id, { x: x0 + w / 2 - NODE_W / 2, y: depth * GAP_Y });
    let x = x0 + (w - (ks.reduce((s, k, i) => s + width(k) + (i ? GAP_X : 0), 0))) / 2;
    for (const k of ks) {
      const kw = width(k);
      place(k, x, depth + 1);
      x += kw + GAP_X;
    }
  };
  const trigger = g.nodes.find((n) => n.type === 'trigger');
  if (trigger) place(trigger.id, 0, 0);
  const maxX = Math.max(0, ...[...pos.values()].map((p) => p.x));
  let y = 0;
  for (const n of g.nodes) {
    if (pos.has(n.id)) continue;
    pos.set(n.id, { x: maxX + NODE_W + 120, y });
    y += 140;
  }
  return { ...g, nodes: g.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })) };
}

// ── Recipes ──────────────────────────────────────────────────────────

type RecipeStep = { id: string; type: StepType; data: StepData };
type RecipeDef = { key: string; name: string; description: string; tags: string[]; steps: RecipeStep[]; links: [string, string, Handle?][] };

const R = (key: string, name: string, description: string, tags: string[], steps: RecipeStep[], links: [string, string, Handle?][]): RecipeDef => ({ key, name, description, tags, steps, links });

export const RECIPES: RecipeDef[] = [
  R('welcome', 'Welcome every new lead', 'Email new leads straight away and give the owner a call task — or a research task if there’s no email.', ['New lead', 'Email'],
    [
      { id: 't', type: 'trigger', data: { trigger: 'LEAD_ARRIVED', hours: 1 } },
      { id: 'c', type: 'condition', data: { field: 'HAS_EMAIL', op: 'is_true' } },
      { id: 'e', type: 'action', data: { type: 'SEND_EMAIL', templateId: '' } },
      { id: 'k', type: 'action', data: { type: 'CREATE_TASK', title: 'Call the new lead', dueInHours: 24 } },
      { id: 'r', type: 'action', data: { type: 'CREATE_TASK', title: 'Find contact details', dueInHours: 24 } },
    ],
    [['t', 'c'], ['c', 'e', 'yes'], ['e', 'k'], ['c', 'r', 'no']]),
  R('speed', 'Speed-to-lead escalation', 'Nudge the owner when a lead goes uncontacted, then escalate to managers and finally the platform team.', ['Follow-up', 'Escalation'],
    [
      { id: 't', type: 'trigger', data: { trigger: 'LEAD_NO_CONTACT', hours: 24 } },
      { id: 'a', type: 'action', data: { type: 'NOTIFY_OWNER', message: '' } },
      { id: 'w', type: 'delay', data: { hours: 24 } },
      { id: 'b', type: 'action', data: { type: 'NOTIFY_MANAGERS' } },
      { id: 'w2', type: 'delay', data: { hours: 24 } },
      { id: 'p', type: 'action', data: { type: 'NOTIFY_PLATFORM' } },
    ],
    [['t', 'a'], ['a', 'w'], ['w', 'b'], ['b', 'w2'], ['w2', 'p']]),
  R('hot', 'Hot-lead fast lane', 'High-scoring leads jump the queue and alert the owner; the rest are tagged for nurturing.', ['Scoring', 'Priority'],
    [
      { id: 't', type: 'trigger', data: { trigger: 'LEAD_ARRIVED', hours: 1 } },
      { id: 'c', type: 'condition', data: { field: 'SCORE', op: 'gte', value: 70 } },
      { id: 'u', type: 'action', data: { type: 'SET_PRIORITY', priority: 'URGENT' } },
      { id: 'n', type: 'action', data: { type: 'NOTIFY_OWNER', message: 'Hot lead — call within the hour' } },
      { id: 'g', type: 'action', data: { type: 'ADD_TAG', tag: 'nurture' } },
    ],
    [['t', 'c'], ['c', 'u', 'yes'], ['u', 'n'], ['c', 'g', 'no']]),
  R('overdue', 'Overdue task escalation', 'Remind the assignee about an overdue task, then escalate it a day later.', ['Tasks'],
    [
      { id: 't', type: 'trigger', data: { trigger: 'TASK_OVERDUE', hours: 4 } },
      { id: 'a', type: 'action', data: { type: 'NOTIFY_OWNER' } },
      { id: 'w', type: 'delay', data: { hours: 24 } },
      { id: 'e', type: 'action', data: { type: 'ESCALATE_TASK' } },
    ],
    [['t', 'a'], ['a', 'w'], ['w', 'e']]),
  R('stale', 'Revive stalled deals', 'Important stuck deals go to managers; others are flagged and tagged as stale.', ['Pipeline'],
    [
      { id: 't', type: 'trigger', data: { trigger: 'STAGE_STAGNANT' } },
      { id: 'c', type: 'condition', data: { field: 'PRIORITY', op: 'is', value: ['HIGH', 'URGENT'] } },
      { id: 'm', type: 'action', data: { type: 'NOTIFY_MANAGERS', message: '' } },
      { id: 'f', type: 'action', data: { type: 'FLAG_STALE' } },
      { id: 'g', type: 'action', data: { type: 'ADD_TAG', tag: 'stale' } },
    ],
    [['t', 'c'], ['c', 'm', 'yes'], ['c', 'f', 'no'], ['f', 'g']]),
  R('weekend', 'Weekend coverage', 'Leads arriving on a weekend alert managers; weekday leads go straight to their owner.', ['New lead', 'Routing'],
    [
      { id: 't', type: 'trigger', data: { trigger: 'LEAD_ARRIVED', hours: 1 } },
      { id: 'c', type: 'condition', data: { field: 'WEEKDAY', op: 'is', value: ['SAT', 'SUN'] } },
      { id: 'm', type: 'action', data: { type: 'NOTIFY_MANAGERS', message: 'Weekend lead — please cover' } },
      { id: 'o', type: 'action', data: { type: 'NOTIFY_OWNER' } },
    ],
    [['t', 'c'], ['c', 'm', 'yes'], ['c', 'o', 'no']]),
];

export function recipeGraph(key: string | null): Graph {
  const r = RECIPES.find((x) => x.key === key);
  if (!r) return tidy({ nodes: [{ id: newId('t'), type: 'trigger', position: { x: 0, y: 0 }, data: DEFAULT_DATA.trigger() }], edges: [] });
  const ids = new Map(r.steps.map((s) => [s.id, newId(s.type[0])]));
  return tidy({
    nodes: r.steps.map((s) => ({ id: ids.get(s.id)!, type: s.type, position: { x: 0, y: 0 }, data: structuredClone(s.data) })),
    edges: r.links.map(([a, b, h]) => ({ id: newId('e'), source: ids.get(a)!, target: ids.get(b)!, sourceHandle: h ?? 'next' })),
  });
}
