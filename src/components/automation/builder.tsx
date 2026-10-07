'use client';
import {
  Background, BackgroundVariant, ConnectionLineType, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow,
  type Connection, type Edge, type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, Clock, Copy, FlaskConical, GitBranch, LayoutGrid, Loader2, MousePointerClick, Play, Redo2, Save, Search, StickyNote, Trash2, Undo2, X, Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useResolvedTheme } from '@/components/shell/theme';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, Switch, Tooltip } from '@/components/ui/overlay';
import { ErrorState, InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import {
  ACTION_HELP, DEFAULT_DATA, describe, fmtHours, graphIssues, narrate, newId, NODE_W, recipeGraph, tidy, TRIGGER_HELP,
  type ActionData, type ConditionData, type DelayData, type Graph, type Handle, type Meta, type StepData, type StepType, type TriggerData,
} from './model';
import { ACTION_ICONS, BuilderContext, edgeTypes, nodeTypes, type AddChoice, type FlowNode } from './nodes';

type WF = { id: string; name: string; description: string | null; enabled: boolean; testMode: boolean; version: number; maxAttempts: number; graph: Graph };
type ListResp = Meta & { workflows: unknown[] };
type One = { workflow: WF; stats: Record<string, number>; traffic: Record<string, number> };
type Run = { id: string; status: string; testMode: boolean; createdAt: string; error: string | null; result: { log?: string[]; path?: string[]; resumeAt?: string } | null; subject: { name: string; organization: string } | null };
type Preview = { matches: number; sample: { title: string; organization: string; hasOwner: boolean; path: string[]; log: string[] }[] };
type Snapshot = { nodes: FlowNode[]; edges: Edge[] };

const toFlow = (g: Graph): Snapshot => ({
  nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data as FlowNode['data'], deletable: n.type !== 'trigger' })),
  edges: g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, type: 'flow' })),
});
const toGraph = (nodes: FlowNode[], edges: Edge[]): Graph => ({
  nodes: nodes.map((n) => ({ id: n.id, type: n.type as StepType, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: n.data as StepData })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: (e.sourceHandle ?? 'next') as Handle })),
});
const strip = (s: Snapshot): Snapshot => ({ nodes: s.nodes.map(({ selected: _s, dragging: _d, measured: _m, ...n }) => n as FlowNode), edges: s.edges.map(({ selected: _s, ...e }) => e) });

export function WorkflowBuilder({ id }: { id: string }) {
  return (
    <ReactFlowProvider>
      <Builder id={id} />
    </ReactFlowProvider>
  );
}

function Builder({ id }: { id: string }) {
  const isNew = id === 'new';
  const search = useSearchParams();
  const meta = useApiQuery<ListResp>('/api/v1/automation/workflows');
  const one = useApiQuery<One>(isNew ? null : `/api/v1/automation/workflows/${id}`);
  if (meta.error || one.error) return <ErrorState description={errorMessage(meta.error ?? one.error)} />;
  if (!meta.data || (!isNew && !one.data)) return <Skeleton className="h-[calc(100dvh-7rem)]" />;
  const initial: WF = isNew
    ? { id: 'new', name: search.get('name') ?? 'Untitled workflow', description: null, enabled: false, testMode: true, version: 0, maxAttempts: 3, graph: recipeGraph(search.get('recipe')) }
    : one.data!.workflow;
  const draftKey = `lcrm.wf.draft.${isNew ? `new.${search.get('recipe') ?? 'blank'}` : id}`;
  return <Canvas key={id} draftKey={draftKey} meta={meta.data} initial={initial} stats={one.data?.stats ?? {}} traffic={one.data?.traffic ?? {}} />;
}

function Canvas({ draftKey, meta, initial, stats, traffic }: { draftKey: string; meta: Meta; initial: WF; stats: Record<string, number>; traffic: Record<string, number> }) {
  const router = useRouter();
  const theme = useResolvedTheme();
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);

  const [info, setInfo] = useState({ name: initial.name, description: initial.description ?? '', enabled: initial.enabled, testMode: initial.testMode, maxAttempts: initial.maxAttempts });
  const start = useMemo(() => toFlow(initial.graph), [initial.graph]);
  const [nodes, setNodes] = useState<FlowNode[]>(start.nodes);
  const [edges, setEdges] = useState<Edge[]>(start.edges);
  const [saved, setSaved] = useState(() => JSON.stringify({ info: { name: initial.name, description: initial.description ?? '', enabled: initial.enabled, testMode: initial.testMode, maxAttempts: initial.maxAttempts }, g: toGraph(start.nodes, start.edges) }));
  const [saving, setSaving] = useState(false);
  const [highlight, setHighlight] = useState<{ ids: Set<string>; label: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ── History ──
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const syncHist = () => setHist({ undo: past.current.length, redo: future.current.length });
  const lastKey = useRef<{ k: string; at: number }>({ k: '', at: 0 });
  const record = useCallback((key = '') => {
    const now = Date.now();
    if (key && key === lastKey.current.k && now - lastKey.current.at < 800) { lastKey.current.at = now; return; }
    lastKey.current = { k: key, at: now };
    past.current.push(strip({ nodes, edges }));
    if (past.current.length > 80) past.current.shift();
    future.current = [];
    syncHist();
  }, [nodes, edges]);
  const undo = () => { const p = past.current.pop(); if (!p) return; future.current.push(strip({ nodes, edges })); setNodes(p.nodes); setEdges(p.edges); syncHist(); };
  const redo = () => { const f = future.current.pop(); if (!f) return; past.current.push(strip({ nodes, edges })); setNodes(f.nodes); setEdges(f.edges); syncHist(); };

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const current = JSON.stringify({ info, g: graph });
  const dirty = current !== saved;
  const { problems, warnings } = useMemo(() => graphIssues(graph, meta), [graph, meta]);
  const issueMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of problems) if (p.nodeId) m.set(p.nodeId, [...(m.get(p.nodeId) ?? []), p.message.replace(/^[^:]+: /, '')]);
    return m;
  }, [problems]);
  const used = useMemo(() => new Set(edges.map((e) => `${e.source}:${e.sourceHandle ?? 'next'}`)), [edges]);
  const selected = nodes.filter((n) => n.selected);
  const sel = selected.length === 1 ? selected[0] : null;
  const triggerType = (nodes.find((n) => n.type === 'trigger')?.data as TriggerData | undefined)?.trigger;

  // ── Local draft safety net: unsaved edits survive reloads and crashes ──
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const d = JSON.parse(raw) as { info: typeof info; g: Graph; at: number };
      if (JSON.stringify({ info: d.info, g: d.g }) === saved) return;
      const f = toFlow(d.g);
      setInfo(d.info); setNodes(f.nodes); setEdges(f.edges);
      toast('Restored your unsaved changes', { description: `From ${fmtAgo(new Date(d.at).toISOString())}`, action: { label: 'Discard', onClick: () => { localStorage.removeItem(draftKey); setInfo({ name: initial.name, description: initial.description ?? '', enabled: initial.enabled, testMode: initial.testMode, maxAttempts: initial.maxAttempts }); setNodes(start.nodes); setEdges(start.edges); } } });
    } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirty) { try { localStorage.removeItem(draftKey); } catch {} return; }
    const t = setTimeout(() => { try { localStorage.setItem(draftKey, JSON.stringify({ info, g: graph, at: Date.now() })); } catch {} }, 600);
    return () => clearTimeout(t);
  }, [dirty, info, graph, draftKey]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // ── Graph operations ──
  const select = (nid: string | null) => setNodes((ns) => ns.map((n) => (n.selected === (n.id === nid) ? n : { ...n, selected: n.id === nid })));

  const makeNode = (choice: AddChoice, position: { x: number; y: number }): FlowNode => {
    const data = choice.type === 'action' ? DEFAULT_DATA[choice.action!]() : DEFAULT_DATA[choice.type]();
    return { id: newId(choice.type[0]), type: choice.type, position, data: data as FlowNode['data'], selected: true };
  };

  const wouldLoop = (source: string, target: string, es: Edge[]) => {
    const seen = new Set<string>();
    const walk = (n: string): boolean => n === source || (!seen.has(n) && (seen.add(n), es.some((e) => e.source === n && walk(e.target))));
    return walk(target);
  };

  const addAfter = (nodeId: string, handle: Handle, choice: AddChoice) => {
    record();
    const src = nodes.find((n) => n.id === nodeId);
    if (!src) return;
    const dx = handle === 'yes' ? -170 : handle === 'no' ? 170 : 0;
    const node = makeNode(choice, { x: src.position.x + dx, y: src.position.y + 168 });
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node]);
    setEdges((es) => [...es.filter((e) => !(e.source === nodeId && (e.sourceHandle ?? 'next') === handle)), { id: newId('e'), source: nodeId, target: node.id, sourceHandle: handle, type: 'flow' }]);
  };

  const insertOnEdge = (edgeId: string, choice: AddChoice) => {
    const e = edges.find((x) => x.id === edgeId);
    if (!e) return;
    record();
    const s = nodes.find((n) => n.id === e.source)!;
    const t = nodes.find((n) => n.id === e.target)!;
    // Push everything downstream of the target down to make room.
    const down = new Set<string>();
    const walk = (n: string) => { if (down.has(n)) return; down.add(n); edges.filter((x) => x.source === n).forEach((x) => walk(x.target)); };
    walk(t.id);
    const node = makeNode(choice, { x: t.position.x, y: (s.position.y + t.position.y) / 2 + 84 });
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false, position: down.has(n.id) ? { ...n.position, y: n.position.y + 168 } : n.position })), node]);
    setEdges((es) => [
      ...es.filter((x) => x.id !== edgeId),
      { id: newId('e'), source: e.source, target: node.id, sourceHandle: e.sourceHandle ?? 'next', type: 'flow' },
      { id: newId('e'), source: node.id, target: e.target, sourceHandle: choice.type === 'condition' ? 'yes' : 'next', type: 'flow' },
    ]);
  };

  const removeEdge = (edgeId: string) => { record(); setEdges((es) => es.filter((e) => e.id !== edgeId)); };

  /** Deletes steps and, when a step had exactly one way in and one way out, reconnects around it. */
  const deleteNodes = (ids: string[]) => {
    const del = new Set(ids.filter((i) => nodes.find((n) => n.id === i)?.type !== 'trigger'));
    if (!del.size) return;
    record();
    let es = edges;
    for (const nid of del) {
      const ins = es.filter((e) => e.target === nid);
      const outs = es.filter((e) => e.source === nid);
      es = es.filter((e) => e.source !== nid && e.target !== nid);
      if (ins.length === 1 && outs.length === 1 && !del.has(ins[0].source) && !del.has(outs[0].target)) {
        es = [...es, { id: newId('e'), source: ins[0].source, target: outs[0].target, sourceHandle: ins[0].sourceHandle ?? 'next', type: 'flow' }];
      }
    }
    setEdges(es);
    setNodes((ns) => ns.filter((n) => !del.has(n.id)));
  };

  const duplicate = (nid: string) => {
    const n = nodes.find((x) => x.id === nid);
    if (!n || n.type === 'trigger') return;
    record();
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { ...n, id: newId(n.type![0]), position: { x: n.position.x + 40, y: n.position.y + 40 }, data: structuredClone(n.data), selected: true }]);
  };

  const updateData = (nid: string, patch: Partial<StepData>) => {
    record(`data:${nid}`);
    setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, data: { ...n.data, ...patch } as FlowNode['data'] } : n)));
  };
  const replaceData = (nid: string, data: StepData) => {
    record();
    setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, data: data as FlowNode['data'] } : n)));
  };

  /** Where a click-to-add step goes: after the selected step, else after the last open output. */
  const tailFor = (): { id: string; handle: Handle } | null => {
    const free = (n: FlowNode): Handle | null => {
      if (n.type === 'note') return null;
      const hs: Handle[] = n.type === 'condition' ? ['yes', 'no'] : ['next'];
      return hs.find((h) => !used.has(`${n.id}:${h}`)) ?? null;
    };
    if (sel) { const h = free(sel); if (h) return { id: sel.id, handle: h }; }
    const trigger = nodes.find((n) => n.type === 'trigger');
    if (!trigger) return null;
    const order: FlowNode[] = [];
    const seen = new Set<string>();
    const q = [trigger.id];
    while (q.length) {
      const cur = q.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const n = nodes.find((x) => x.id === cur);
      if (n) order.push(n);
      edges.filter((e) => e.source === cur).forEach((e) => q.push(e.target));
    }
    for (let i = order.length - 1; i >= 0; i--) { const h = free(order[i]); if (h) return { id: order[i].id, handle: h }; }
    return null;
  };

  const addFromPalette = (choice: AddChoice) => {
    if (choice.type === 'note') {
      record();
      const vp = rf.screenToFlowPosition({ x: (wrap.current?.getBoundingClientRect().left ?? 0) + 80, y: (wrap.current?.getBoundingClientRect().top ?? 0) + 80 });
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), makeNode(choice, vp)]);
      return;
    }
    const tail = tailFor();
    if (tail) addAfter(tail.id, tail.handle, choice);
    else {
      record();
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), makeNode(choice, { x: 400, y: 0 })]);
    }
    setTimeout(() => rf.fitView({ duration: 300, padding: 0.25, maxZoom: 1 }), 50);
  };

  /** Drop from the palette. Snaps onto the nearest open output above the drop point ("magnet"). */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/x-lcrm-step');
    if (!raw) return;
    const choice = JSON.parse(raw) as AddChoice;
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const position = { x: p.x - NODE_W / 2, y: p.y - 30 };
    record();
    const node = makeNode(choice, position);
    let best: { id: string; handle: Handle; d: number } | null = null;
    if (choice.type !== 'note') {
      for (const n of nodes) {
        if (n.type === 'note') continue;
        const hs: [Handle, number][] = n.type === 'condition' ? [['yes', 0.25], ['no', 0.75]] : [['next', 0.5]];
        for (const [h, f] of hs) {
          if (used.has(`${n.id}:${h}`)) continue;
          const hx = n.position.x + NODE_W * f;
          const hy = n.position.y + (n.measured?.height ?? 90);
          const dy = p.y - hy;
          if (dy < 10 || dy > 320) continue;
          const d = Math.hypot(p.x - hx, dy);
          if (d < 300 && (!best || d < best.d)) best = { id: n.id, handle: h, d };
        }
      }
    }
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node]);
    if (best) {
      const b = best;
      setEdges((es) => [...es, { id: newId('e'), source: b.id, target: node.id, sourceHandle: b.handle, type: 'flow' }]);
    }
  };

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    record();
    const handle = (c.sourceHandle ?? 'next') as Handle;
    setEdges((es) => [...es.filter((e) => !(e.source === c.source && (e.sourceHandle ?? 'next') === handle)), { id: newId('e'), source: c.source!, target: c.target!, sourceHandle: handle, type: 'flow' }]);
  };
  const isValidConnection = (c: Connection | Edge) => {
    if (!c.source || !c.target || c.source === c.target) return false;
    if (nodes.find((n) => n.id === c.target)?.type === 'trigger') return false;
    if (nodes.find((n) => n.id === c.target)?.type === 'note' || nodes.find((n) => n.id === c.source)?.type === 'note') return false;
    return !wouldLoop(c.source, c.target, edges);
  };

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    const removals = changes.filter((c) => c.type === 'remove');
    if (removals.length) { deleteNodes(removals.map((c) => c.id)); return; }
    setNodes((ns) => applyNodeChanges(changes, ns));
  };

  const doTidy = () => {
    record();
    const t = tidy(graph);
    const pos = new Map(t.nodes.map((n) => [n.id, n.position]));
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    setTimeout(() => rf.fitView({ duration: 400, padding: 0.2, maxZoom: 1 }), 30);
  };

  // ── Save / test ──
  const body = (overrides: Partial<typeof info> = {}) => ({ name: info.name.trim(), description: info.description.trim() || null, enabled: info.enabled, testMode: info.testMode, maxAttempts: info.maxAttempts, ...overrides, graph });
  const save = async (overrides: Partial<typeof info> = {}) => {
    if (problems.length) {
      toast.error(`Fix ${problems.length} issue${problems.length === 1 ? '' : 's'} before saving`, { description: problems[0].message });
      if (problems[0].nodeId) focusNode(problems[0].nodeId);
      return false;
    }
    if (info.name.trim().length < 2) { toast.error('Give the workflow a name'); return false; }
    setSaving(true);
    try {
      const b = body(overrides);
      const res = await api<{ id: string; version: number }>(initial.id === 'new' ? '/api/v1/automation/workflows' : `/api/v1/automation/workflows/${initial.id}`, { method: initial.id === 'new' ? 'POST' : 'PUT', body: b });
      const nextInfo = { ...info, ...overrides };
      setInfo(nextInfo);
      setSaved(JSON.stringify({ info: nextInfo, g: graph }));
      try { localStorage.removeItem(draftKey); } catch {}
      toast.success(overrides.enabled === true ? (nextInfo.testMode ? 'Workflow is on in test mode' : 'Workflow is live') : overrides.enabled === false ? 'Workflow turned off' : 'Workflow saved', { description: `Version ${res.version}` });
      if (initial.id === 'new') router.replace(`/admin/automation/${res.id}`);
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const tryIt = async () => {
    if (problems.length) { toast.error('Fix the highlighted issues first', { description: problems[0].message }); return; }
    setPreviewing(true);
    try {
      setPreview(await api<Preview>('/api/v1/automation/preview', { body: body() }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPreviewing(false);
    }
  };
  const remove = async () => {
    await api(`/api/v1/automation/workflows/${initial.id}`, { method: 'DELETE' });
    try { localStorage.removeItem(draftKey); } catch {}
    toast.success('Workflow deleted');
    router.push('/admin/automation');
  };

  const focusNode = (nid: string) => {
    select(nid);
    const n = nodes.find((x) => x.id === nid);
    if (n) rf.setCenter(n.position.x + NODE_W / 2, n.position.y + 60, { zoom: Math.max(rf.getZoom(), 0.9), duration: 400 });
  };

  // ── Keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.closest('input, textarea, select, [contenteditable="true"]');
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === 'd' && sel) { e.preventDefault(); duplicate(sel.id); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) { e.preventDefault(); deleteNodes(selected.map((n) => n.id)); }
      if (e.key === 'Escape') { select(null); setHighlight(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const status = !info.enabled ? { label: 'Off', tone: 'neutral' as const } : info.testMode ? { label: 'Test mode', tone: 'warn' as const } : { label: 'Live', tone: 'ok' as const };
  const ctx = { meta, issues: issueMap, traffic, highlight: highlight?.ids ?? null, used, addAfter, insertOnEdge, removeEdge, updateNote: (nid: string, text: string) => updateData(nid, { text }) };

  return (
    <BuilderContext.Provider value={ctx}>
      <div className="-mx-3 -my-4 flex h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] flex-col sm:-mx-4 sm:-my-6 md:-mx-6">
        {/* Top bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
          <Link href="/admin/automation" className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-subtle hover:bg-surface-3 hover:text-fg"><ArrowLeft className="size-3.5" />Automation</Link>
          <ChevronRight className="size-3.5 text-faint" />
          <input
            value={info.name}
            onChange={(e) => setInfo({ ...info, name: e.target.value })}
            aria-label="Workflow name"
            className="min-w-[120px] flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-[14px] font-semibold tracking-[-0.015em] outline-none hover:border-border focus:border-border-strong md:max-w-[360px]"
          />
          <Badge tone={status.tone} dot>{status.label}</Badge>
          {initial.version > 0 && <span className="text-[11px] text-subtle">v{initial.version}</span>}
          <span className={cn('text-[11px]', dirty ? 'text-warn' : 'text-subtle')}>{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
          <div className="ml-auto flex flex-wrap items-center gap-1 max-sm:w-full max-sm:justify-between">
            <Tooltip content="Undo (⌘Z)"><Button size="icon" variant="ghost" aria-label="Undo" disabled={!hist.undo} onClick={undo}><Undo2 /></Button></Tooltip>
            <Tooltip content="Redo (⇧⌘Z)"><Button size="icon" variant="ghost" aria-label="Redo" disabled={!hist.redo} onClick={redo}><Redo2 /></Button></Tooltip>
            <Tooltip content="Tidy up the layout"><Button size="sm" variant="ghost" onClick={doTidy}><LayoutGrid /><span className="max-sm:hidden">Tidy</span></Button></Tooltip>
            <div className="mx-1 h-5 w-px bg-border max-sm:hidden" />
            <Tooltip content="See who matches right now and which path each would take — nothing is changed">
              <Button size="sm" variant="ghost" loading={previewing} onClick={tryIt}><Play /><span className="max-sm:hidden">Try it</span></Button>
            </Tooltip>
            <label className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-muted">
              <FlaskConical className="size-3.5" /><span className="max-sm:sr-only">Test mode</span>
              <Switch checked={info.testMode} onCheckedChange={(v) => (initial.id === 'new' ? setInfo({ ...info, testMode: v }) : void save({ testMode: v }))} aria-label="Test mode" />
            </label>
            <label className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-muted">
              On
              <Switch checked={info.enabled} onCheckedChange={(v) => void save({ enabled: v })} aria-label="Turn workflow on" />
            </label>
            <Button size="sm" variant="primary" loading={saving} disabled={!dirty && initial.id !== 'new'} onClick={() => void save()}><Save /> Save</Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <Palette meta={meta} onAdd={addFromPalette} />

          {/* Canvas */}
          <div ref={wrap} className="relative min-w-0 flex-1 bg-bg" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }} onDrop={onDrop}>
            <ReactFlow<FlowNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={() => {}}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onNodeDragStart={() => record()}
              onPaneClick={() => { select(null); }}
              deleteKeyCode={null}
              colorMode={theme}
              connectionLineType={ConnectionLineType.SmoothStep}
              connectionLineStyle={{ stroke: 'var(--fg)', strokeWidth: 1.5 }}
              defaultEdgeOptions={{ type: 'flow' }}
              fitView
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
              minZoom={0.2}
              maxZoom={1.75}
              snapToGrid
              snapGrid={[8, 8]}
              proOptions={{ hideAttribution: true }}
              className="workflow-canvas"
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="var(--grid-dot)" />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap position="bottom-right" pannable zoomable nodeBorderRadius={8} nodeColor={() => 'var(--surface-3)'} nodeStrokeColor={() => 'var(--border-strong)'} maskColor="color-mix(in srgb, var(--bg) 70%, transparent)" className="!h-24 !w-36 max-md:!hidden" />
              {highlight && (
                <Panel position="top-center">
                  <div className="flex items-center gap-2 rounded-full border border-border-strong bg-surface px-3 py-1.5 text-[12px] shadow-[var(--raised-shadow)]">
                    <MousePointerClick className="size-3.5 text-subtle" />Showing the path for <b className="font-medium">{highlight.label}</b>
                    <button type="button" className="rounded-full p-0.5 text-subtle hover:text-fg" onClick={() => setHighlight(null)} aria-label="Clear path"><X className="size-3.5" /></button>
                  </div>
                </Panel>
              )}
              {nodes.length === 1 && (
                <Panel position="top-center">
                  <div className="mt-2 rounded-lg border border-dashed border-border-strong bg-surface/90 px-4 py-2.5 text-center text-[12px] text-muted backdrop-blur">
                    Click <b className="font-medium text-fg">+</b> under the trigger, or drag a step from the left onto the canvas.
                  </div>
                </Panel>
              )}
            </ReactFlow>
          </div>

          {/* Inspector */}
          <aside className={cn('shrink-0 flex-col border-border bg-surface max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-40 max-md:h-[72dvh] max-md:rounded-t-2xl max-md:border-t max-md:pb-[env(safe-area-inset-bottom)] max-md:shadow-2xl md:w-[300px] md:border-l xl:w-[340px]', sel ? 'flex' : 'hidden md:flex')}>
            {sel ? (
              <StepInspector
                key={sel.id}
                node={sel}
                meta={meta}
                trigger={triggerType}
                issues={issueMap.get(sel.id) ?? []}
                onPatch={(p) => updateData(sel.id, p)}
                onReplace={(d) => replaceData(sel.id, d)}
                onDelete={() => deleteNodes([sel.id])}
                onDuplicate={() => duplicate(sel.id)}
                onClose={() => select(null)}
              />
            ) : (
              <WorkflowPanel
                id={initial.id}
                info={info}
                setInfo={setInfo}
                graph={graph}
                meta={meta}
                stats={stats}
                problems={problems}
                warnings={warnings}
                onFocus={focusNode}
                onHighlight={(path, label) => setHighlight(path.length ? { ids: new Set(path), label } : null)}
                onDelete={info.enabled ? undefined : () => setConfirmDelete(true)}
              />
            )}
          </aside>
        </div>
      </div>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)} title="Test run on live data" description="Conditions are checked against real records; actions and waits are only simulated. Nothing was changed." size="lg"
        footer={<Button variant="primary" onClick={() => setPreview(null)}>Done</Button>}>
        {preview && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3">
              <Zap className="size-4 text-subtle" />
              <div><div className="text-[18px] font-semibold tracking-[-0.02em] tabular-nums">{preview.matches}{preview.matches >= 50 ? '+' : ''}</div><div className="text-[11.5px] text-subtle">record{preview.matches === 1 ? '' : 's'} match the trigger right now{info.enabled ? '' : ' — they would start this workflow once it is on'}</div></div>
            </div>
            {!preview.sample.length ? <InlineNotice>No one matches the trigger at the moment. Try a different time window or remove filters.</InlineNotice> : (
              <div className="max-h-[50vh] overflow-auto rounded-lg border border-border">
                {preview.sample.map((s, i) => (
                  <button key={i} type="button" onClick={() => { setHighlight({ ids: new Set(s.path), label: s.title }); setPreview(null); }} className="flex w-full flex-col gap-1 border-b border-border px-4 py-2.5 text-left last:border-b-0 hover:bg-surface-2">
                    <span className="flex items-center gap-2 text-[12.5px]"><span className="font-medium">{s.title}</span><span className="text-subtle">· {s.organization}</span>{!s.hasOwner && <Badge>No owner</Badge>}<span className="ml-auto flex items-center gap-1 text-[11px] text-subtle">Show path <ChevronRight className="size-3" /></span></span>
                    <span className="flex flex-wrap items-center gap-1 text-[11.5px] text-muted">{s.log.map((l, j) => <span key={j} className="flex items-center gap-1">{j > 0 && <ChevronRight className="size-3 text-faint" />}{l}</span>)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Dialog>
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title={`Delete “${info.name}”`} danger confirmLabel="Delete workflow" description="Its run history is deleted too. This cannot be undone." onConfirm={remove} />
    </BuilderContext.Provider>
  );
}

// ── Palette ──────────────────────────────────────────────────────────

function Palette({ meta, onAdd }: { meta: Meta; onAdd: (c: AddChoice) => void }) {
  const [q, setQ] = useState('');
  const items: { group: string; choice: AddChoice; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { group: 'Logic', choice: { type: 'condition' }, label: 'Check a condition', hint: 'Split into Yes / No', icon: GitBranch },
    { group: 'Logic', choice: { type: 'delay' }, label: 'Wait', hint: 'Pause before the next step', icon: Clock },
    ...Object.entries(meta.actions).filter(([k]) => k !== 'DELAY').map(([k, label]) => ({ group: 'Actions', choice: { type: 'action' as const, action: k }, label, hint: ACTION_HELP[k]?.split('.')[0] ?? '', icon: ACTION_ICONS[k] })),
    { group: 'Other', choice: { type: 'note' }, label: 'Sticky note', hint: 'Explain the flow to your team', icon: StickyNote },
  ];
  const shown = items.filter((i) => !q || `${i.label} ${i.hint}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <aside className="hidden w-[248px] shrink-0 flex-col border-r border-border bg-surface lg:flex">
      <div className="border-b border-border p-3">
        <div className="text-[12.5px] font-medium">Steps</div>
        <div className="mb-2 text-[11px] text-subtle">Drag onto the canvas, or click to add after the selected step.</div>
        <div className="relative"><Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-subtle" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search steps" className="h-8 pl-7 text-[12px]" /></div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {['Logic', 'Actions', 'Other'].map((g) => {
          const list = shown.filter((i) => i.group === g);
          if (!list.length) return null;
          return (
            <div key={g} className="mb-3">
              <div className="eyebrow px-1.5 pb-1.5">{g}</div>
              <div className="flex flex-col gap-1">
                {list.map((i) => (
                  <button
                    key={i.label}
                    type="button"
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData('application/x-lcrm-step', JSON.stringify(i.choice)); e.dataTransfer.effectAllowed = 'move'; }}
                    onClick={() => onAdd(i.choice)}
                    className="group flex cursor-grab items-start gap-2.5 rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-left transition-all hover:-translate-y-px hover:border-border-strong hover:shadow-[var(--raised-shadow)] active:cursor-grabbing"
                  >
                    <span className="grid size-6 shrink-0 place-items-center rounded-md border border-border bg-surface text-muted group-hover:text-fg"><i.icon className="size-3.5" /></span>
                    <span className="min-w-0"><span className="block text-[12px] leading-tight font-medium">{i.label}</span><span className="block truncate text-[10.5px] text-subtle">{i.hint}</span></span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ── Inspector: selected step ─────────────────────────────────────────

function StepInspector({ node, meta, trigger, issues, onPatch, onReplace, onDelete, onDuplicate, onClose }: {
  node: FlowNode; meta: Meta; trigger?: string; issues: string[];
  onPatch: (p: Partial<StepData>) => void; onReplace: (d: StepData) => void; onDelete: () => void; onDuplicate: () => void; onClose: () => void;
}) {
  const type = node.type as StepType;
  const d = describe({ type, data: node.data as StepData }, meta);
  return (
    <>
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="eyebrow">{type === 'trigger' ? 'When' : type === 'condition' ? 'If' : type === 'delay' ? 'Wait' : type === 'note' ? 'Note' : 'Then'}</div>
          <div className="truncate text-[13.5px] font-medium">{d.title}</div>
        </div>
        <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}><X /></Button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {issues.length > 0 && <InlineNotice tone="warn" className="mb-4">{issues.join(' · ')}</InlineNotice>}
        {type === 'trigger' && <TriggerForm data={node.data as TriggerData} meta={meta} onPatch={onPatch} onReplace={onReplace} />}
        {type === 'condition' && <ConditionForm data={node.data as ConditionData} meta={meta} onReplace={onReplace} />}
        {type === 'action' && <ActionForm data={node.data as ActionData} meta={meta} trigger={trigger} onPatch={onPatch} onReplace={onReplace} />}
        {type === 'delay' && <DelayForm data={node.data as DelayData} onPatch={onPatch} />}
        {type === 'note' && <Field label="Note"><Textarea rows={6} value={(node.data as { text: string }).text} onChange={(e) => onPatch({ text: e.target.value })} /></Field>}
      </div>
      {type !== 'trigger' && (
        <div className="flex gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="ghost" onClick={onDuplicate}><Copy /> Duplicate</Button>
          <Button size="sm" variant="ghost" className="ml-auto text-danger hover:text-danger" onClick={onDelete}><Trash2 /> Delete step</Button>
        </div>
      )}
    </>
  );
}

function Chips({ options, value, onChange, labels }: { options: string[]; value: string[]; onChange: (v: string[]) => void; labels?: Record<string, string> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button key={o} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
            className={cn('h-7 rounded-md border px-2.5 text-[11.5px] transition-colors', on ? 'border-fg bg-fg text-inverse' : 'border-border-strong text-muted hover:text-fg')}>
            {labels?.[o] ?? o.charAt(0) + o.slice(1).toLowerCase()}
          </button>
        );
      })}
    </div>
  );
}

function OrgPicker({ meta, value, onChange }: { meta: Meta; value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const list = meta.organizations.filter((o) => o.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="rounded-md border border-border-strong">
      <div className="border-b border-border p-1.5"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search workspaces" className="h-7 text-[12px]" /></div>
      <div className="max-h-40 overflow-y-auto p-1">
        {list.map((o) => (
          <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[12px] hover:bg-surface-3">
            <input type="checkbox" className="accent-[var(--fg)]" checked={value.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} />
            {o.name}
          </label>
        ))}
        {!list.length && <div className="px-2 py-1.5 text-[11.5px] text-subtle">No matches</div>}
      </div>
    </div>
  );
}

function TriggerForm({ data, meta, onPatch, onReplace }: { data: TriggerData; meta: Meta; onPatch: (p: Partial<TriggerData>) => void; onReplace: (d: TriggerData) => void }) {
  const help = TRIGGER_HELP[data.trigger];
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-fg-2">Start this workflow when…</div>
        <div className="flex flex-col gap-1.5">
          {Object.entries(meta.triggers).map(([k, label]) => (
            <button key={k} type="button" onClick={() => onReplace({ ...data, trigger: k, hours: TRIGGER_HELP[k]?.defaultHours || undefined })}
              className={cn('flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[12.5px] transition-colors', data.trigger === k ? 'border-fg bg-surface-3' : 'border-border hover:border-border-strong')}>
              <span className={cn('grid size-3.5 place-items-center rounded-full border', data.trigger === k ? 'border-fg' : 'border-faint')}>{data.trigger === k && <span className="size-1.5 rounded-full bg-fg" />}</span>
              {label}
            </button>
          ))}
        </div>
      </div>
      {help && (
        <Field label={help.hoursLabel} hint={data.trigger === 'LEAD_ARRIVED' ? 'Leads that arrived within this window when the workflow checks (every 5 minutes). Each lead runs once.' : undefined}>
          <Input type="number" min={0} step={0.5} value={data.hours ?? ''} placeholder={String(help.defaultHours)} onChange={(e) => onPatch({ hours: e.target.value === '' ? undefined : Math.max(0.1, Number(e.target.value)) })} />
        </Field>
      )}
      <Field label="Only for these priorities" hint="Leave empty for all.">
        <Chips options={['LOW', 'MEDIUM', 'HIGH', 'URGENT']} value={data.priorities ?? []} onChange={(v) => onPatch({ priorities: v.length ? v : undefined })} />
      </Field>
      <Field label="Only in these workspaces" hint="Leave empty to apply to every workspace.">
        <OrgPicker meta={meta} value={data.organizationIds ?? []} onChange={(v) => onPatch({ organizationIds: v.length ? v : undefined })} />
      </Field>
    </div>
  );
}

const OPS: Record<string, [string, string][]> = {
  enum: [['is', 'is any of'], ['is_not', 'is none of']],
  org: [['is', 'is any of'], ['is_not', 'is none of']],
  number: [['gte', 'is at least'], ['lte', 'is at most'], ['is', 'is exactly']],
  text: [['is', 'is'], ['is_not', 'is not'], ['contains', 'contains']],
  bool: [['is_true', 'Yes'], ['is_false', 'No']],
};

function ConditionForm({ data, meta, onReplace }: { data: ConditionData; meta: Meta; onReplace: (d: ConditionData) => void }) {
  const f = meta.conditionFields[data.field];
  const kind = f?.kind ?? 'enum';
  const vals = Array.isArray(data.value) ? data.value : data.value == null || data.value === '' ? [] : [String(data.value)];
  const setField = (field: string) => {
    const k = meta.conditionFields[field].kind;
    onReplace({ field, op: OPS[k][0][0], value: k === 'number' ? 50 : k === 'bool' ? undefined : [] });
  };
  return (
    <div className="flex flex-col gap-4">
      <Field label="Check">
        <Select value={data.field} onChange={(e) => setField(e.target.value)}>
          {Object.entries(meta.conditionFields).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
      </Field>
      {kind === 'bool' ? (
        <InlineNotice>Leads where this is true continue down <b>Yes</b>; the rest go down <b>No</b>.</InlineNotice>
      ) : (
        <>
          <Field label="Condition">
            <Select value={data.op} onChange={(e) => onReplace({ ...data, op: e.target.value })}>{OPS[kind].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          </Field>
          <Field label="Value" hint={kind === 'text' ? 'Separate several values with commas.' : undefined}>
            {kind === 'enum' && <Chips options={f!.options ?? []} value={vals} onChange={(v) => onReplace({ ...data, value: v })} />}
            {kind === 'org' && <OrgPicker meta={meta} value={vals} onChange={(v) => onReplace({ ...data, value: v })} />}
            {kind === 'number' && <Input type="number" value={typeof data.value === 'number' ? data.value : Number(vals[0] ?? 0)} onChange={(e) => onReplace({ ...data, value: Number(e.target.value) })} />}
            {kind === 'text' && <Input value={vals.join(', ')} placeholder={data.field === 'COUNTRY' ? 'United States, Canada' : data.field === 'TAG' ? 'vip' : 'Website'} onChange={(e) => onReplace({ ...data, value: e.target.value.split(',').map((x) => x.trimStart()) })} />}
          </Field>
        </>
      )}
      <div className="grid grid-cols-2 gap-2 text-[11.5px]">
        <div className="rounded-lg border border-border bg-surface-2 p-2.5"><div className="mb-0.5 font-semibold tracking-wider text-fg uppercase">Yes</div><span className="text-subtle">Matches — follows the left path</span></div>
        <div className="rounded-lg border border-dashed border-border-strong p-2.5"><div className="mb-0.5 font-semibold tracking-wider text-muted uppercase">No</div><span className="text-subtle">Everything else — right path</span></div>
      </div>
    </div>
  );
}

function ActionForm({ data, meta, trigger, onPatch, onReplace }: { data: ActionData; meta: Meta; trigger?: string; onPatch: (p: Partial<ActionData>) => void; onReplace: (d: ActionData) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Action">
        <Select value={data.type} onChange={(e) => onReplace(DEFAULT_DATA[e.target.value]() as ActionData)}>
          {Object.entries(meta.actions).filter(([k]) => k !== 'DELAY').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </Field>
      <p className="-mt-2 text-[11.5px] leading-relaxed text-subtle">{ACTION_HELP[data.type]}</p>
      {['NOTIFY_OWNER', 'NOTIFY_MANAGERS', 'NOTIFY_PLATFORM'].includes(data.type) && (
        <Field label="Message (optional)" hint="Leave blank for a sensible default that names the lead and workflow.">
          <Textarea rows={3} maxLength={300} value={data.message ?? ''} onChange={(e) => onPatch({ message: e.target.value })} />
        </Field>
      )}
      {data.type === 'SEND_EMAIL' && (
        <>
          <Field label="Email template">
            <Select value={data.templateId ?? ''} onChange={(e) => onPatch({ templateId: e.target.value })}>
              <option value="">Choose a template…</option>
              {meta.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          {data.templateId && <p className="-mt-2 text-[11.5px] text-subtle">Subject: {meta.templates.find((t) => t.id === data.templateId)?.subject}</p>}
          <Link href="/admin/email?tab=templates" target="_blank" className="-mt-1 text-[11.5px] text-muted underline underline-offset-2 hover:text-fg">Create or edit templates ↗</Link>
          <InlineNotice>Sent from each workspace’s default email sender. Workspaces without a sender are skipped and the run log says so.</InlineNotice>
        </>
      )}
      {data.type === 'CREATE_TASK' && (
        <>
          <Field label="Task title"><Input value={data.title ?? ''} maxLength={200} onChange={(e) => onPatch({ title: e.target.value })} /></Field>
          <Field label="Due in"><DurationInput hours={data.dueInHours ?? 24} min={0} onChange={(h) => onPatch({ dueInHours: Math.round(h) })} /></Field>
        </>
      )}
      {data.type === 'SET_PRIORITY' && <Field label="New priority"><Chips options={['HIGH', 'URGENT']} value={[data.priority ?? 'HIGH']} onChange={(v) => onPatch({ priority: v[v.length - 1] ?? 'HIGH' })} /></Field>}
      {data.type === 'ADD_TAG' && <Field label="Tag" hint="Created in the workspace if it doesn’t exist yet."><Input value={data.tag ?? ''} maxLength={40} placeholder="e.g. hot-lead" onChange={(e) => onPatch({ tag: e.target.value })} /></Field>}
      {data.type === 'ESCALATE_TASK' && trigger !== 'TASK_OVERDUE' && <InlineNotice tone="warn">This action only does something when the workflow starts from “Task is overdue”.</InlineNotice>}
    </div>
  );
}

function DurationInput({ hours, onChange, min = 0.1 }: { hours: number; onChange: (h: number) => void; min?: number }) {
  const unit = hours >= 24 && hours % 24 === 0 ? 'days' : hours < 1 && hours > 0 ? 'minutes' : 'hours';
  const [u, setU] = useState<'minutes' | 'hours' | 'days'>(unit);
  const factor = u === 'days' ? 24 : u === 'minutes' ? 1 / 60 : 1;
  const shown = +(hours / factor).toFixed(2);
  return (
    <div className="flex gap-2">
      <Input type="number" min={0} value={shown} onChange={(e) => onChange(Math.max(min, Number(e.target.value) * factor))} className="flex-1" />
      <Select value={u} onChange={(e) => setU(e.target.value as typeof u)} className="w-28">
        <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
      </Select>
    </div>
  );
}

function DelayForm({ data, onPatch }: { data: DelayData; onPatch: (p: Partial<DelayData>) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Wait for"><DurationInput hours={data.hours} onChange={(h) => onPatch({ hours: Math.min(720, h) })} /></Field>
      <div className="flex flex-wrap gap-1.5">
        {[1, 4, 24, 72, 168].map((h) => (
          <button key={h} type="button" onClick={() => onPatch({ hours: h })} className={cn('h-7 rounded-md border px-2.5 text-[11.5px]', data.hours === h ? 'border-fg bg-fg text-inverse' : 'border-border-strong text-muted hover:text-fg')}>{fmtHours(h)}</button>
        ))}
      </div>
      <InlineNotice>After waiting, the workflow checks the trigger again. If the situation was resolved in the meantime (for example the lead was contacted), it stops here.</InlineNotice>
    </div>
  );
}

// ── Inspector: workflow (nothing selected) ───────────────────────────

function WorkflowPanel({ id, info, setInfo, graph, meta, stats, problems, warnings, onFocus, onHighlight, onDelete }: {
  id: string; info: { name: string; description: string; enabled: boolean; testMode: boolean; maxAttempts: number }; setInfo: (i: { name: string; description: string; enabled: boolean; testMode: boolean; maxAttempts: number }) => void;
  graph: Graph; meta: Meta; stats: Record<string, number>; problems: { message: string; nodeId?: string }[]; warnings: { message: string; nodeId?: string }[];
  onFocus: (id: string) => void; onHighlight: (path: string[], label: string) => void; onDelete?: () => void;
}) {
  const [tab, setTab] = useState<'overview' | 'runs'>('overview');
  const lines = narrate(graph, meta);
  return (
    <>
      <div className="flex gap-1 border-b border-border px-3 pt-2">
        {(['overview', 'runs'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={cn('-mb-px border-b px-2.5 py-2 text-[12.5px]', tab === t ? 'border-fg text-fg' : 'border-transparent text-subtle hover:text-fg-2')}>{t === 'runs' ? 'Run history' : 'Overview'}</button>
        ))}
      </div>
      {tab === 'overview' ? (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {problems.length > 0 ? (
            <div className="mb-4 rounded-lg border border-warn/40 bg-warn-dim p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-warn"><AlertTriangle className="size-3.5" />{problems.length} thing{problems.length === 1 ? '' : 's'} to fix before saving</div>
              <ul className="flex flex-col gap-1">{problems.slice(0, 6).map((p, i) => <li key={i}><button type="button" disabled={!p.nodeId} onClick={() => p.nodeId && onFocus(p.nodeId)} className="text-left text-[11.5px] text-fg-2 hover:underline disabled:no-underline">{p.message}</button></li>)}</ul>
            </div>
          ) : (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] text-muted"><CheckCircle2 className="size-3.5 text-ok" />Ready — everything is connected and configured.</div>
          )}
          {warnings.map((w, i) => <button key={i} type="button" onClick={() => w.nodeId && onFocus(w.nodeId)} className="mb-2 block text-left text-[11.5px] text-subtle hover:text-fg">⚠ {w.message}</button>)}

          <div className="eyebrow mb-1.5">In plain English</div>
          <div className="mb-5 rounded-lg border border-border bg-surface-2 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-2">{lines.join('\n') || '—'}</div>

          <div className="flex flex-col gap-3">
            <Field label="Description"><Textarea rows={2} value={info.description} maxLength={500} placeholder="What does this workflow do and why?" onChange={(e) => setInfo({ ...info, description: e.target.value })} /></Field>
            <Field label="Retries if a step fails" hint="After this many attempts the run is stopped and a low-severity security alert is raised.">
              <Input type="number" min={1} max={10} value={info.maxAttempts} onChange={(e) => setInfo({ ...info, maxAttempts: Math.min(10, Math.max(1, Number(e.target.value))) })} className="w-24" />
            </Field>
            <InlineNotice>
              <b>Test mode</b> records what would happen without notifying anyone, sending email or changing leads. Use it to watch real runs safely, then switch it off to go live.
            </InlineNotice>
          </div>

          {Object.keys(stats).length > 0 && (
            <>
              <div className="eyebrow mt-5 mb-1.5">All-time runs</div>
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(stats).map(([k, v]) => <div key={k} className="rounded-lg border border-border px-2.5 py-2"><div className="text-[15px] font-semibold tabular-nums">{v}</div><div className="text-[10.5px] text-subtle capitalize">{k.toLowerCase()}</div></div>)}
              </div>
            </>
          )}
          {onDelete && id !== 'new' && <Button size="sm" variant="ghost" className="mt-6 text-danger hover:text-danger" onClick={onDelete}><Trash2 /> Delete workflow</Button>}
        </div>
      ) : (
        <Runs id={id} onHighlight={onHighlight} />
      )}
    </>
  );
}

function Runs({ id, onHighlight }: { id: string; onHighlight: (path: string[], label: string) => void }) {
  const { data, isLoading } = useApiQuery<{ total: number; rows: Run[] }>(id === 'new' ? null : `/api/v1/automation/executions?workflowId=${id}&page=1&pageSize=30`, { refetchInterval: 15_000 });
  if (id === 'new') return <div className="p-4 text-[12px] text-subtle">Save the workflow to see its runs here.</div>;
  if (isLoading) return <div className="p-4"><Loader2 className="size-4 animate-spin text-subtle" /></div>;
  if (!data?.rows.length) return <div className="p-4 text-[12px] text-subtle">No runs yet. Runs start within 5 minutes of a match once the workflow is on.</div>;
  return (
    <div className="flex-1 overflow-y-auto">
      {data.rows.map((r) => (
        <button key={r.id} type="button" onClick={() => onHighlight(r.result?.path ?? [], r.subject?.name ?? 'this run')} className="flex w-full flex-col gap-1 border-b border-border px-4 py-2.5 text-left hover:bg-surface-2">
          <span className="flex items-center gap-2">
            <StatusBadge status={r.status} />
            {r.testMode && <Badge tone="warn">test</Badge>}
            <span className="ml-auto text-[11px] text-subtle">{fmtAgo(r.createdAt)}</span>
          </span>
          <span className="truncate text-[12.5px] font-medium">{r.subject?.name ?? 'Deleted record'}<span className="font-normal text-subtle"> · {r.subject?.organization ?? '—'}</span></span>
          <span className="line-clamp-2 text-[11px] text-muted">{r.error ?? r.result?.log?.join(' → ') ?? '—'}</span>
        </button>
      ))}
    </div>
  );
}

