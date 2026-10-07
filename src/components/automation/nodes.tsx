'use client';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, Handle, Position, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import {
  AlertTriangle, ArrowUpCircle, Bell, Clock, Flag, GitBranch, Mail, Megaphone, Plus, ShieldAlert, StickyNote, Tag, Trash2, UserCheck, Users, Zap, ListChecks,
} from 'lucide-react';
import { createContext, useContext, useState } from 'react';
import { cn } from '@/lib/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/overlay';
import { describe, NODE_W, type Handle as H, type Meta, type NoteData, type StepData, type StepType } from './model';

export const ACTION_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  NOTIFY_OWNER: UserCheck, NOTIFY_MANAGERS: Users, NOTIFY_PLATFORM: ShieldAlert, SEND_EMAIL: Mail, CREATE_TASK: ListChecks,
  SET_PRIORITY: ArrowUpCircle, ADD_TAG: Tag, ESCALATE_TASK: Megaphone, FLAG_STALE: Flag,
};
export const KIND_ICON: Record<StepType, React.ComponentType<{ className?: string }>> = { trigger: Zap, condition: GitBranch, action: Bell, delay: Clock, note: StickyNote };
const KIND_LABEL: Record<StepType, string> = { trigger: 'When', condition: 'If', action: 'Then', delay: 'Wait', note: 'Note' };

export type AddChoice = { type: StepType; action?: string };

export type BuilderCtx = {
  meta: Meta;
  issues: Map<string, string[]>;
  traffic: Record<string, number>;
  highlight: Set<string> | null;
  used: Set<string>;
  addAfter: (nodeId: string, handle: H, choice: AddChoice) => void;
  insertOnEdge: (edgeId: string, choice: AddChoice) => void;
  removeEdge: (edgeId: string) => void;
  updateNote: (nodeId: string, text: string) => void;
};
export const BuilderContext = createContext<BuilderCtx | null>(null);
const useBuilder = () => useContext(BuilderContext)!;

export type FlowNode = Node<StepData & Record<string, unknown>, StepType>;

/** The "what next?" menu used by + buttons on outputs and edges. */
export function AddMenu({ onPick, children, align = 'center' }: { onPick: (c: AddChoice) => void; children: React.ReactNode; align?: 'start' | 'center' | 'end' }) {
  const { meta } = useBuilder();
  const [open, setOpen] = useState(false);
  const pick = (c: AddChoice) => { setOpen(false); onPick(c); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-64 p-1.5">
        <div className="eyebrow px-2 pt-1 pb-1.5">Add a step</div>
        <MenuRow icon={GitBranch} label="Check a condition" hint="Split into Yes / No paths" onClick={() => pick({ type: 'condition' })} />
        <MenuRow icon={Clock} label="Wait" hint="Pause, then continue if still relevant" onClick={() => pick({ type: 'delay' })} />
        <div className="my-1 h-px bg-border" />
        {Object.entries(meta.actions).filter(([k]) => k !== 'DELAY').map(([k, label]) => (
          <MenuRow key={k} icon={ACTION_ICONS[k] ?? Bell} label={label} onClick={() => pick({ type: 'action', action: k })} />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function MenuRow({ icon: Icon, label, hint, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; hint?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-start gap-2.5 rounded px-2 py-1.5 text-left hover:bg-surface-3">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-subtle" />
      <span><span className="block text-[12px]">{label}</span>{hint && <span className="block text-[10.5px] text-subtle">{hint}</span>}</span>
    </button>
  );
}

function AddButton({ nodeId, handle, style, label }: { nodeId: string; handle: H; style?: React.CSSProperties; label?: string }) {
  const { addAfter, used } = useBuilder();
  if (used.has(`${nodeId}:${handle}`)) return null;
  return (
    <div className="nodrag nopan absolute flex flex-col items-center" style={{ top: '100%', ...style }}>
      <div className="h-5 w-px bg-border-strong" />
      <AddMenu onPick={(c) => addAfter(nodeId, handle, c)}>
        <button type="button" aria-label={`Add a step${label ? ` for ${label}` : ''}`} className="grid size-6 place-items-center rounded-full border border-border-strong bg-surface text-muted shadow-[var(--raised-shadow)] transition-all hover:scale-110 hover:border-fg hover:text-fg">
          <Plus className="size-3.5" />
        </button>
      </AddMenu>
    </div>
  );
}

const handleCls = '!size-2.5 !border-2 !border-[var(--surface)] !bg-[var(--muted)] hover:!bg-[var(--fg)]';

function StepCard({ id, type, data, selected }: { id: string; type: StepType; data: StepData; selected: boolean }) {
  const { meta, issues, traffic, highlight } = useBuilder();
  const d = describe({ type, data }, meta);
  const problems = issues.get(id) ?? [];
  const Icon = type === 'action' ? (ACTION_ICONS[(data as { type: string }).type] ?? Bell) : KIND_ICON[type];
  const dim = highlight && !highlight.has(id);
  const lit = highlight?.has(id);
  const runs = traffic[id];
  return (
    <div
      className={cn(
        'group relative rounded-xl border bg-surface text-left shadow-[var(--raised-shadow)] transition-all duration-200',
        selected ? 'border-fg ring-1 ring-fg' : problems.length ? 'border-warn/60' : 'border-border-strong hover:border-faint',
        dim && 'opacity-35',
        lit && 'ring-2 ring-fg',
      )}
      style={{ width: NODE_W }}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className={cn(
          'flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-semibold tracking-[0.08em] uppercase',
          type === 'trigger' ? 'bg-fg text-inverse' : type === 'condition' ? 'border border-fg text-fg' : type === 'delay' ? 'border border-dashed border-faint text-muted' : 'bg-surface-3 text-fg-2',
        )}>
          <Icon className="size-3" />{KIND_LABEL[type]}
        </span>
        {runs ? <span className="ml-auto text-[10.5px] tabular-nums text-subtle" title="Runs that reached this step (current version)">{runs.toLocaleString()} run{runs === 1 ? '' : 's'}</span> : null}
        {problems.length > 0 && <AlertTriangle className={cn('size-3.5 text-warn', !runs && 'ml-auto')} aria-label="Needs attention" />}
      </div>
      <div className="px-3 py-2.5">
        <div className="text-[13px] font-medium leading-snug tracking-[-0.01em]">{d.title}</div>
        {d.summary && <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted">{d.summary}</div>}
        {problems.length > 0 && <div className="mt-1.5 text-[11px] text-warn">{problems[0]}</div>}
      </div>
    </div>
  );
}

export function TriggerNode({ id, data, selected }: NodeProps<FlowNode>) {
  return (
    <div className="relative">
      <StepCard id={id} type="trigger" data={data} selected={!!selected} />
      <Handle type="source" id="next" position={Position.Bottom} className={handleCls} />
      <AddButton nodeId={id} handle="next" style={{ left: '50%', transform: 'translateX(-50%)' }} />
    </div>
  );
}

export function ActionNode({ id, data, selected, type }: NodeProps<FlowNode>) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Top} className={handleCls} />
      <StepCard id={id} type={type as StepType} data={data} selected={!!selected} />
      <Handle type="source" id="next" position={Position.Bottom} className={handleCls} />
      <AddButton nodeId={id} handle="next" style={{ left: '50%', transform: 'translateX(-50%)' }} />
    </div>
  );
}

export function ConditionNode({ id, data, selected }: NodeProps<FlowNode>) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Top} className={handleCls} />
      <StepCard id={id} type="condition" data={data} selected={!!selected} />
      <Handle type="source" id="yes" position={Position.Bottom} style={{ left: '25%' }} className={handleCls} />
      <Handle type="source" id="no" position={Position.Bottom} style={{ left: '75%' }} className={handleCls} />
      <span className="pointer-events-none absolute -bottom-[18px] left-[25%] -translate-x-1/2 rounded bg-fg px-1.5 text-[9.5px] font-semibold tracking-wider text-inverse uppercase">Yes</span>
      <span className="pointer-events-none absolute -bottom-[18px] left-[75%] -translate-x-1/2 rounded border border-border-strong bg-surface px-1.5 text-[9.5px] font-semibold tracking-wider text-muted uppercase">No</span>
      <AddButton nodeId={id} handle="yes" label="Yes" style={{ left: '25%', transform: 'translateX(-50%)', top: 'calc(100% + 14px)' }} />
      <AddButton nodeId={id} handle="no" label="No" style={{ left: '75%', transform: 'translateX(-50%)', top: 'calc(100% + 14px)' }} />
    </div>
  );
}

export function NoteNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { updateNote } = useBuilder();
  return (
    <div className={cn('rounded-lg border border-dashed bg-surface-3/80 p-2 shadow-[var(--card-shadow)]', selected ? 'border-fg' : 'border-faint')} style={{ width: 220 }}>
      <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold tracking-[0.08em] text-subtle uppercase"><StickyNote className="size-3" />Note</div>
      <textarea
        className="nodrag nowheel h-20 w-full resize-none bg-transparent text-[12px] leading-snug outline-none placeholder:text-subtle"
        placeholder="Write a note for your team…"
        value={(data as NoteData).text}
        onChange={(e) => updateNote(id, e.target.value)}
      />
    </div>
  );
}

export const nodeTypes = { trigger: TriggerNode, action: ActionNode, delay: ActionNode, condition: ConditionNode, note: NoteNode };

/** Smooth-step edge with hover controls: insert a step in between, or remove the connection. */
export function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, sourceHandleId, style }: EdgeProps) {
  const { insertOnEdge, removeEdge, highlight } = useBuilder();
  const [path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 14, offset: 22 });
  const [hover, setHover] = useState(false);
  const branch = sourceHandleId === 'yes' || sourceHandleId === 'no';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{ ...style, stroke: selected || hover ? 'var(--fg)' : 'var(--faint)', strokeWidth: selected || hover ? 2 : 1.5, strokeDasharray: sourceHandleId === 'no' ? '5 4' : undefined, opacity: highlight ? 0.5 : 1 }}
      />
      <path d={path} fill="none" stroke="transparent" strokeWidth={22} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} />
      <EdgeLabelRenderer>
        <div
          className={cn('nodrag nopan absolute flex items-center gap-1 transition-opacity', hover || selected ? 'opacity-100' : 'opacity-0')}
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly + (branch ? 8 : 0)}px)`, pointerEvents: 'all' }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          <AddMenu onPick={(c) => insertOnEdge(id, c)}>
            <button type="button" aria-label="Insert a step here" className="grid size-6 place-items-center rounded-full border border-border-strong bg-surface text-muted shadow-[var(--raised-shadow)] hover:border-fg hover:text-fg"><Plus className="size-3.5" /></button>
          </AddMenu>
          <button type="button" aria-label="Remove connection" onClick={() => removeEdge(id)} className="grid size-6 place-items-center rounded-full border border-border-strong bg-surface text-muted shadow-[var(--raised-shadow)] hover:border-danger hover:text-danger"><Trash2 className="size-3" /></button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const edgeTypes = { flow: FlowEdge };
