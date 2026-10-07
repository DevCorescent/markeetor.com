'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRight, Clock, FlaskConical, GitBranch, Plus, Sparkles, Zap } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { describe, narrate, RECIPES, type Graph, type Meta } from '@/components/automation/model';
import { ACTION_ICONS, KIND_ICON } from '@/components/automation/nodes';
import { DataTable } from '@/components/data/data-table';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Switch, Tabs, TabsList, TabsTrigger, Tooltip } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { EmptyState, Skeleton } from '@/components/ui/states';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtDateTime, humanize } from '@/lib/format';
import { useApiMutation, useApiQuery, useUrlState } from '@/lib/hooks';

type WF = { id: string; name: string; description: string | null; trigger: string; graph: Graph; enabled: boolean; testMode: boolean; version: number; maxAttempts: number; updatedAt: string; lastRunAt: string | null; stats: Record<string, number> };
type Resp = Meta & { workflows: WF[] };
type Exec = { id: string; status: string; testMode: boolean; subjectType: string; subjectId: string; attempts: number; error: string | null; version: number; createdAt: string; finishedAt: string | null; result: { log?: string[]; resumeAt?: string } | null; workflow: { name: string }; workflowId: string; subject: { name: string; organization: string } | null };

export function Automation() {
  const [s, set] = useUrlState({ tab: 'workflows' });
  const { data } = useApiQuery<Resp>('/api/v1/automation/workflows');
  const toggle = useApiMutation(
    (w: WF) => api(`/api/v1/automation/workflows/${w.id}`, { method: 'PUT', body: { name: w.name, description: w.description, graph: w.graph, enabled: !w.enabled, testMode: w.testMode, maxAttempts: w.maxAttempts } }),
    { success: 'Workflow updated', invalidate: ['/api/v1/automation'] },
  );
  return (
    <>
      <PageHeader
        title="Automation"
        description="Build workflows on a visual canvas — when something happens, check conditions and act. Workflows are checked every 5 minutes and run once per lead per situation."
        actions={<Link href="/admin/automation/new" className={buttonClass({ variant: 'primary' })}><Plus /> New workflow</Link>}
      />
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}><TabsList className="mb-5"><TabsTrigger value="workflows">Workflows</TabsTrigger><TabsTrigger value="executions">Run history</TabsTrigger></TabsList></Tabs>
      {s.tab === 'workflows' ? (
        <>
          <Recipes />
          <div className="mt-7 mb-3 flex items-center justify-between">
            <h2 className="text-[14px] font-medium">Your workflows</h2>
            {data && <span className="text-[11.5px] text-subtle">{data.workflows.filter((w) => w.enabled).length} on · {data.workflows.length} total</span>}
          </div>
          {!data ? <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-48" />)}</div> : !data.workflows.length ? (
            <Card><EmptyState icon={GitBranch} title="No workflows yet" description="Start from a recipe above, or build one from scratch on the canvas." action={<Link href="/admin/automation/new" className={buttonClass({ variant: 'primary' })}><Plus /> New workflow</Link>} /></Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {data.workflows.map((w) => <WorkflowCard key={w.id} w={w} meta={data} onToggle={() => toggle.mutate(w)} />)}
            </div>
          )}
        </>
      ) : <Executions workflows={data?.workflows ?? []} />}
    </>
  );
}

function Recipes() {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2"><Sparkles className="size-3.5 text-subtle" /><h2 className="text-[14px] font-medium">Start from a recipe</h2><span className="text-[11.5px] text-subtle">Ready-made flows you can adjust on the canvas</span></div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {RECIPES.map((r) => (
          <Link key={r.key} href={`/admin/automation/new?recipe=${r.key}&name=${encodeURIComponent(r.name)}`} className="group flex flex-col rounded-lg border border-border bg-surface p-4 shadow-[var(--card-shadow)] transition-all hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[var(--raised-shadow)]">
            <div className="mb-2 flex items-center gap-1.5">
              {r.steps.slice(0, 5).map((st, i) => {
                const Icon = st.type === 'action' ? ACTION_ICONS[(st.data as { type: string }).type] ?? Zap : KIND_ICON[st.type];
                return (
                  <span key={i} className="flex items-center gap-1.5">
                    {i > 0 && <span className="h-px w-2.5 bg-border-strong" />}
                    <span className={cn('grid size-6 place-items-center rounded-md border', st.type === 'trigger' ? 'border-fg bg-fg text-inverse' : 'border-border-strong text-muted')}><Icon className="size-3" /></span>
                  </span>
                );
              })}
            </div>
            <div className="text-[13px] font-medium">{r.name}</div>
            <p className="mt-0.5 flex-1 text-[11.5px] leading-relaxed text-subtle">{r.description}</p>
            <div className="mt-3 flex items-center gap-1.5">
              {r.tags.map((t) => <Badge key={t}>{t}</Badge>)}
              <span className="ml-auto flex items-center gap-1 text-[11.5px] text-muted group-hover:text-fg">Use recipe <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" /></span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function WorkflowCard({ w, meta, onToggle }: { w: WF; meta: Meta; onToggle: () => void }) {
  const trigger = w.graph.nodes.find((n) => n.type === 'trigger');
  const steps = w.graph.nodes.filter((n) => n.type !== 'trigger' && n.type !== 'note');
  const branches = steps.filter((n) => n.type === 'condition').length;
  const runs = Object.values(w.stats).reduce((a, b) => a + b, 0);
  const lines = narrate(w.graph, meta).slice(1, 5);
  return (
    <Card className="group flex flex-col transition-shadow hover:shadow-[var(--raised-shadow)]">
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <Link href={`/admin/automation/${w.id}`} className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-medium tracking-[-0.01em] group-hover:underline group-hover:underline-offset-2">{w.name}</span>
            {!w.enabled ? <Badge>Off</Badge> : w.testMode ? <Badge tone="warn"><FlaskConical className="size-3" /> Test mode</Badge> : <Badge tone="ok" dot>Live</Badge>}
          </div>
          <p className="mt-1 line-clamp-2 text-[12px] text-subtle">{w.description || (trigger ? `When ${describe(trigger, meta).summary.charAt(0).toLowerCase()}${describe(trigger, meta).summary.slice(1)}` : '')}</p>
        </Link>
        <Tooltip content={w.enabled ? 'Turn off' : 'Turn on'}><span><Switch checked={w.enabled} onCheckedChange={onToggle} aria-label={`Turn ${w.name} ${w.enabled ? 'off' : 'on'}`} /></span></Tooltip>
      </div>
      <Link href={`/admin/automation/${w.id}`} className="mx-4 my-3 rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted">
        {lines.join('\n') || '—'}{narrate(w.graph, meta).length > 5 ? '\n  …' : ''}
      </Link>
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2.5 text-[11px] text-subtle">
        <span>{steps.length} step{steps.length === 1 ? '' : 's'}{branches ? ` · ${branches} branch${branches === 1 ? '' : 'es'}` : ''}</span>
        <span>v{w.version}</span>
        <span className="tabular-nums">{runs.toLocaleString()} run{runs === 1 ? '' : 's'}</span>
        {(w.stats.FAILED ?? 0) + (w.stats.DEAD ?? 0) > 0 && <span className="text-danger">{(w.stats.FAILED ?? 0) + (w.stats.DEAD ?? 0)} failed</span>}
        <span className="flex items-center gap-1"><Clock className="size-3" />{w.lastRunAt ? `Last run ${fmtAgo(w.lastRunAt)}` : 'Never run'}</span>
        <Link href={`/admin/automation/${w.id}`} className="ml-auto flex items-center gap-1 text-muted hover:text-fg">Open canvas <ArrowRight className="size-3" /></Link>
      </div>
    </Card>
  );
}

function Executions({ workflows }: { workflows: WF[] }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [wf, setWf] = useState('');
  const { data, isFetching } = useApiQuery<{ total: number; rows: Exec[] }>(`/api/v1/automation/executions?page=${page}&pageSize=25${status ? `&status=${status}` : ''}${wf ? `&workflowId=${wf}` : ''}`, { refetchInterval: 15_000 });
  const cols: ColumnDef<Exec, unknown>[] = [
    { id: 'wf', header: 'Workflow', cell: ({ row: { original: e } }) => <Link href={`/admin/automation/${e.workflowId}`} className="hover:underline">{e.workflow.name} <span className="text-subtle">v{e.version}</span>{e.testMode && <Badge tone="warn" className="ml-1.5">test</Badge>}</Link> },
    { id: 'status', header: 'Status', cell: ({ row: { original: e } }) => <StatusBadge status={e.status} /> },
    { id: 'subject', header: 'For', cell: ({ row: { original: e } }) => (e.subject ? <span>{e.subject.name} <span className="text-subtle">· {e.subject.organization}</span></span> : <span className="font-mono text-[11px] text-subtle">{e.subjectType}:{e.subjectId.slice(0, 10)}</span>) },
    { id: 'log', header: 'What happened', cell: ({ row: { original: e } }) => <span className="block max-w-[420px] truncate text-muted">{e.error ?? e.result?.log?.join(' → ') ?? '—'}{e.result?.resumeAt && ` (resumes ${fmtDateTime(e.result.resumeAt)})`}</span> },
    { id: 'attempts', header: 'Attempts', cell: ({ row: { original: e } }) => <span className="tnum">{e.attempts}</span> },
    { id: 'at', header: 'Started', cell: ({ row: { original: e } }) => <span className="text-subtle">{fmtAgo(e.createdAt)}</span> },
  ];
  return (
    <DataTable columns={cols} data={data?.rows ?? []} total={data?.total ?? 0} page={page} pageSize={25} onPage={setPage} loading={isFetching} getRowId={(r) => r.id} dense
      toolbar={
        <div className="flex flex-wrap gap-2 max-sm:w-full">
          <Select className="h-7 w-52 max-sm:w-auto max-sm:flex-1" value={wf} onChange={(e) => { setWf(e.target.value); setPage(1); }} aria-label="Workflow"><option value="">All workflows</option>{workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
          <Select className="h-7 w-40 max-sm:w-auto max-sm:flex-1" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status"><option value="">All statuses</option>{['RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD', 'SKIPPED'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</Select>
        </div>
      } />
  );
}
