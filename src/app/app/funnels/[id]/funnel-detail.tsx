'use client';
import { ArrowDown, ArrowUp, Bell, CheckSquare, ExternalLink, Mail, Megaphone, MoreHorizontal, Pause, Play, Plus, Save, Trash2, Zap } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { FilterBuilder } from '@/components/data/filter-builder';
import { FunnelChart, type FunnelAnalysis } from '@/components/funnels/funnel-chart';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, Menu, MenuContent, MenuItem, MenuTrigger, Switch, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { ErrorState, InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import type { Condition } from '@/lib/filters';
import { fmtAgo, fmtCompact, fmtInt, fmtMoney, fmtPct } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { clientLeadFields, type ClientFacets } from '../../leads/client-leads';

type Action = 'EMAIL' | 'TASK' | 'NOTIFY';
type Automation = { enabled: boolean; action: Action; templateId?: string | null; taskTitle?: string | null; dueInHours: number; message?: string | null; onlyNew: boolean };
type Stage = { id: string; name: string; description?: string | null; conditions: Condition[]; automation?: Automation | null };
type Draft = { name: string; description: string | null; goal: string | null; status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED'; baseFilter: { conditions: Condition[] }; stages: Stage[] };
type Campaign = { id: string; stageId: string; stageName: string; scope: string; channel: Action; name: string; automated: boolean; recipients: number; skipped: number; createdAt: string; email: { status: string; sentCount: number; openedCount: number; failedCount: number; totalRecipients: number } | null };
type Detail = { funnel: Draft & { id: string; updatedAt: string }; analysis: FunnelAnalysis; campaigns: Campaign[]; automationRuns: Record<string, number> };

const CHANNELS: { key: Action; label: string; hint: string; icon: typeof Mail }[] = [
  { key: 'EMAIL', label: 'Email campaign', hint: 'Send a template to every lead with an email', icon: Mail },
  { key: 'TASK', label: 'Follow-up tasks', hint: 'Create a task for each lead’s owner', icon: CheckSquare },
  { key: 'NOTIFY', label: 'Team alert', hint: 'Notify owners about their leads here', icon: Bell },
];
const sid = () => `s${Math.random().toString(36).slice(2, 9)}`;

export function FunnelDetail({ id, canManage, canEmail }: { id: string; canManage: boolean; canEmail: boolean }) {
  const router = useRouter();
  const [confirmDel, setConfirmDel] = useState(false);
  const { data, error, refetch } = useApiQuery<Detail>(`/api/v1/crm/funnels/${id}`);
  const facets = useApiQuery<ClientFacets>('/api/v1/crm/leads/facets');
  const fields = useMemo(() => clientLeadFields(facets.data, true), [facets.data]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<FunnelAnalysis | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [launch, setLaunch] = useState<string | null>(null);

  useEffect(() => {
    if (data && !dirty) {
      const f = data.funnel;
      setDraft({ name: f.name, description: f.description, goal: f.goal, status: f.status, baseFilter: { conditions: f.baseFilter?.conditions ?? [] }, stages: f.stages });
      setSel((s) => s ?? f.stages[0]?.id ?? null);
    }
  }, [data, dirty]);

  // Live preview while editing: recount every stage against the unsaved definition.
  useEffect(() => {
    if (!dirty || !draft) return;
    const ctl = new AbortController();
    setPreviewing(true);
    const t = setTimeout(() => {
      api<FunnelAnalysis>('/api/v1/crm/funnels/preview', { body: { baseFilter: draft.baseFilter, stages: draft.stages.map(({ id, name, conditions }) => ({ id, name: name || 'Stage', conditions })) }, signal: ctl.signal })
        .then(setPreview).catch(() => {}).finally(() => setPreviewing(false));
    }, 450);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [draft, dirty]);

  if (error) return <ErrorState description={errorMessage(error)} />;
  if (!data || !draft) return <div className="flex flex-col gap-4"><Skeleton className="h-14" /><Skeleton className="h-24" /><Skeleton className="h-[420px]" /></div>;

  const analysis = dirty && preview ? preview : data.analysis;
  const change = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); setDirty(true); };
  const setStage = (sidv: string, patch: Partial<Stage>) => change({ stages: draft.stages.map((s) => (s.id === sidv ? { ...s, ...patch } : s)) });
  const idx = draft.stages.findIndex((s) => s.id === sel);
  const stage = idx >= 0 ? draft.stages[idx] : null;
  const stat = analysis.stages.find((s) => s.id === sel);
  const bn = analysis.bottleneck ? analysis.stages.find((s) => s.id === analysis.bottleneck!.id) : null;
  const value = analysis.stages.reduce((n, s) => n + s.value, 0);
  const autos = draft.stages.filter((s) => s.automation?.enabled).length;

  const save = async (patch?: Partial<Draft>) => {
    const body = { ...draft, ...patch };
    setSaving(true);
    try {
      await api(`/api/v1/crm/funnels/${id}`, { method: 'PUT', body });
      setDirty(false);
      setPreview(null);
      await refetch();
      toast.success(patch?.status ? (patch.status === 'ACTIVE' ? 'Funnel resumed' : 'Funnel paused') : 'Funnel saved');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const addStage = () => {
    if (draft.stages.length >= 10) return;
    const s: Stage = { id: sid(), name: `Stage ${draft.stages.length + 1}`, conditions: [], automation: null };
    change({ stages: [...draft.stages, s] });
    setSel(s.id);
  };
  const move = (d: -1 | 1) => {
    const j = idx + d;
    if (idx < 0 || j < 0 || j >= draft.stages.length) return;
    const st = [...draft.stages];
    [st[idx], st[j]] = [st[j], st[idx]];
    change({ stages: st });
  };
  const remove = () => {
    if (draft.stages.length <= 2) return toast.error('A funnel needs at least two stages');
    const st = draft.stages.filter((s) => s.id !== sel);
    change({ stages: st });
    setSel(st[Math.max(0, idx - 1)]?.id ?? null);
  };
  const archive = async () => {
    try { await api(`/api/v1/crm/funnels/${id}`, { method: 'DELETE' }); router.push('/app/funnels'); } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <>
      <PageHeader crumbs={[{ label: 'Funnels', href: '/app/funnels' }, { label: draft.name }]}
        title={canManage ? <input aria-label="Funnel name" value={draft.name} onChange={(e) => change({ name: e.target.value })} className="w-full min-w-[200px] bg-transparent outline-none focus:underline focus:decoration-border-strong focus:underline-offset-4" /> : draft.name}
        description={canManage ? <input aria-label="Goal" value={draft.goal ?? ''} onChange={(e) => change({ goal: e.target.value || null })} placeholder="Add a goal, e.g. “Turn new leads into booked demos”" className="w-full max-w-xl bg-transparent outline-none placeholder:text-subtle" /> : draft.goal}
        actions={canManage && (
          <>
            {dirty && <span className="text-[11.5px] text-subtle">Unsaved changes</span>}
            {dirty && <Button variant="ghost" onClick={() => { setDirty(false); setPreview(null); }}>Discard</Button>}
            <Button variant={dirty ? 'primary' : 'secondary'} loading={saving} disabled={!dirty} onClick={() => save()}><Save /> Save</Button>
            <Button onClick={() => save({ status: draft.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })} disabled={saving}>{draft.status === 'ACTIVE' ? <><Pause /> Pause</> : <><Play /> Resume</>}</Button>
            <Menu><MenuTrigger asChild><Button size="icon" variant="ghost" aria-label="More"><MoreHorizontal /></Button></MenuTrigger><MenuContent><MenuItem danger onSelect={() => setConfirmDel(true)}><Trash2 className="size-3.5" />Delete funnel</MenuItem></MenuContent></Menu>
          </>
        )} />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <Kpi label="Leads in funnel" value={fmtInt(analysis.stages[0]?.reached ?? 0)} sub={analysis.total !== (analysis.stages[0]?.reached ?? 0) ? `of ${fmtInt(analysis.total)} matching the filter` : undefined} />
        <Kpi label="End-to-end conversion" value={fmtPct(analysis.overallConversion, 1)} sub={`${fmtInt(analysis.stages.at(-1)?.reached ?? 0)} reached “${analysis.stages.at(-1)?.name ?? ''}”`} />
        <Kpi label="Biggest drop" value={bn ? fmtPct(analysis.bottleneck!.rate, 0) : '—'} sub={bn ? `after “${bn.name}”` : 'No drop-off yet'} warn={Boolean(bn && analysis.bottleneck!.rate > 0.6)} />
        <Kpi label="Pipeline value" value={value ? fmtCompact(value) : '—'} sub="deal value across stages" />
        <Kpi label="Automations" value={`${autos}`} sub={draft.status === 'ACTIVE' ? 'running every 5 minutes' : 'paused with the funnel'} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Card className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <span className="text-[12px] text-muted">Funnel includes</span>
            {canManage ? <FilterBuilder fields={fields} value={draft.baseFilter.conditions} onChange={(c) => change({ baseFilter: { conditions: c } })} /> : <span className="text-[12px]">{draft.baseFilter.conditions.length ? `${draft.baseFilter.conditions.length} filters` : 'All active leads'}</span>}
            {!draft.baseFilter.conditions.length && <span className="text-[11.5px] text-subtle">All active leads</span>}
            {dirty && <Badge tone="outline" className="ml-auto">{previewing ? 'Recounting…' : 'Live preview'}</Badge>}
          </div>
          <div className="p-3">
            <FunnelChart analysis={analysis} selected={sel} onSelect={setSel} loading={previewing} />
            {canManage && draft.stages.length < 10 && <button type="button" onClick={addStage} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border-strong py-2.5 text-[12px] text-muted hover:border-fg hover:text-fg"><Plus className="size-3.5" />Add stage</button>}
          </div>
        </Card>

        {stage && (
          <StagePanel key={stage.id} funnelId={id} stage={stage} stat={stat} index={idx} count={draft.stages.length} fields={fields} canManage={canManage} canEmail={canEmail}
            dirty={dirty} runs={data.automationRuns[stage.id] ?? 0} onChange={(p) => setStage(stage.id, p)} onMove={move} onRemove={remove} onLaunch={() => setLaunch(stage.id)} />
        )}
      </div>

      <Card className="mt-4">
        <div className="flex items-center justify-between border-b border-border px-4 py-3"><div className="text-[13px] font-medium">Campaigns & automation runs</div><span className="text-[11.5px] text-subtle">{data.campaigns.length} total</span></div>
        {!data.campaigns.length ? <div className="px-4 py-10 text-center text-[12.5px] text-subtle">No campaigns yet. Select a stage and launch one — it reaches exactly the leads in that stage.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr className="border-b border-border text-left text-[11px] text-subtle"><th className="px-4 py-2 font-medium">Campaign</th><th className="px-4 py-2 font-medium">Stage</th><th className="px-4 py-2 font-medium">Channel</th><th className="px-4 py-2 text-right font-medium">Reached</th><th className="px-4 py-2 font-medium">Result</th><th className="px-4 py-2 font-medium">When</th></tr></thead>
              <tbody>
                {data.campaigns.map((c) => {
                  const ch = CHANNELS.find((x) => x.key === c.channel)!;
                  return (
                    <tr key={c.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5"><div className="flex items-center gap-1.5 font-medium">{c.automated && <Zap className="size-3 text-subtle" />}{c.name}</div></td>
                      <td className="px-4 py-2.5 text-muted">{c.stageName}{c.scope === 'REACHED' && <span className="text-subtle"> + later</span>}</td>
                      <td className="px-4 py-2.5"><span className="flex items-center gap-1.5 text-muted"><ch.icon className="size-3.5" />{ch.label}</span></td>
                      <td className="tnum px-4 py-2.5 text-right">{fmtInt(c.recipients)}{c.skipped ? <span className="text-subtle"> (+{c.skipped} skipped)</span> : ''}</td>
                      <td className="px-4 py-2.5">{c.email ? <span className="flex items-center gap-2"><StatusBadge status={c.email.status} /><span className="tnum text-[11.5px] text-muted">{fmtInt(c.email.sentCount)} sent · {c.email.sentCount ? fmtPct(c.email.openedCount / c.email.sentCount, 0) : '—'} opened</span></span> : <span className="text-[11.5px] text-muted">{c.channel === 'TASK' ? 'Tasks created' : 'Alerts sent'}</span>}</td>
                      <td className="px-4 py-2.5 text-subtle">{fmtAgo(c.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog open={confirmDel} onOpenChange={setConfirmDel} title="Delete this funnel?" description="The funnel and its automations stop. Campaign history is kept and your leads are not affected." confirmLabel="Delete" danger onConfirm={archive} />
      {launch && <LaunchDialog funnelId={id} stage={draft.stages.find((s) => s.id === launch)!} canEmail={canEmail} onClose={() => setLaunch(null)} onDone={() => { setLaunch(null); refetch(); }} />}
    </>
  );
}

const Kpi = ({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) => (
  <Card className={cn('px-4 py-3.5', warn && 'border-warn/40')}><div className="eyebrow">{label}</div><div className={cn('tnum mt-2 text-[22px] leading-none font-[520] tracking-[-0.03em]', warn && 'text-warn')}>{value}</div>{sub && <div className="mt-1.5 truncate text-[11px] text-subtle">{sub}</div>}</Card>
);

function StagePanel({ funnelId, stage, stat, index, count, fields, canManage, canEmail, dirty, runs, onChange, onMove, onRemove, onLaunch }: {
  funnelId: string; stage: Stage; stat?: FunnelAnalysis['stages'][number]; index: number; count: number; fields: ReturnType<typeof clientLeadFields>; canManage: boolean; canEmail: boolean; dirty: boolean; runs: number;
  onChange: (p: Partial<Stage>) => void; onMove: (d: -1 | 1) => void; onRemove: () => void; onLaunch: () => void;
}) {
  const [tab, setTab] = useState('leads');
  return (
    <Card className="flex min-w-0 flex-col self-start">
      <div className="border-b border-border px-4 pt-4 pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="eyebrow">Stage {index + 1} of {count}</div>
          {canManage && <div className="flex items-center gap-0.5">
            <Button size="icon" variant="ghost" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp /></Button>
            <Button size="icon" variant="ghost" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown /></Button>
            <Button size="icon" variant="ghost" aria-label="Remove stage" disabled={count <= 2} onClick={onRemove}><Trash2 /></Button>
          </div>}
        </div>
        <div className="mt-1 text-[16px] font-[560] tracking-[-0.015em]">{stage.name || 'Untitled stage'}</div>
        {stat && <div className="tnum mt-1 text-[12px] text-muted"><b className="font-medium text-fg">{fmtInt(stat.current)}</b> here now · {fmtInt(stat.reached)} reached{index > 0 && ` · ${fmtPct(stat.conversion, 0)} from previous`}</div>}
        {canManage && <Button className="mt-3 w-full" variant="primary" onClick={onLaunch} disabled={dirty}><Megaphone /> Launch campaign to this stage</Button>}
        {canManage && dirty && <div className="mt-1.5 text-center text-[11px] text-subtle">Save your changes to launch a campaign</div>}
      </div>
      <Tabs value={tab} onValueChange={setTab}><TabsList className="mx-4 mt-3"><TabsTrigger value="leads">Leads</TabsTrigger>{canManage && <TabsTrigger value="setup">Conditions</TabsTrigger>}{canManage && <TabsTrigger value="auto">Automation{stage.automation?.enabled ? ' ●' : ''}</TabsTrigger>}</TabsList></Tabs>
      <div className="p-4">
        {tab === 'leads' && <StageLeads funnelId={funnelId} stageId={stage.id} dirty={dirty} />}
        {tab === 'setup' && (
          <div className="flex flex-col gap-4">
            <Field label="Stage name"><Input value={stage.name} maxLength={60} onChange={(e) => onChange({ name: e.target.value })} /></Field>
            <Field label="Description" hint="Shown to your team"><Input value={stage.description ?? ''} maxLength={200} onChange={(e) => onChange({ description: e.target.value || null })} placeholder="What does it mean for a lead to be here?" /></Field>
            <div>
              <div className="mb-1.5 text-[12px] font-medium">A lead is in this stage when…</div>
              <FilterBuilder fields={fields} value={stage.conditions} onChange={(c) => onChange({ conditions: c })} />
              <p className="mt-2 text-[11.5px] leading-relaxed text-subtle">{stage.conditions.length ? 'All conditions must match.' : 'No conditions — every lead in the funnel counts as having reached this stage.'} Leads that match a later stage also count as having passed through this one.</p>
            </div>
          </div>
        )}
        {tab === 'auto' && <AutomationEditor a={stage.automation ?? null} canEmail={canEmail} runs={runs} onChange={(a) => onChange({ automation: a })} />}
      </div>
    </Card>
  );
}

type LeadRow = { id: string; fullName: string; company: string | null; status: string; score: number; dealValue: number | null; currency: string | null; lastActivityAt: string | null; owner: { name: string } | null };

function StageLeads({ funnelId, stageId, dirty }: { funnelId: string; stageId: string; dirty: boolean }) {
  const [scope, setScope] = useState<'CURRENT' | 'REACHED'>('CURRENT');
  const [page, setPage] = useState(1);
  const { data, isFetching } = useApiQuery<{ total: number; rows: LeadRow[] }>(`/api/v1/crm/funnels/${funnelId}/leads?stageId=${stageId}&scope=${scope}&page=${page}&pageSize=12`);
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 12));
  return (
    <div className="flex flex-col gap-3">
      {dirty && <InlineNotice>Showing the saved funnel. Save to see leads for your changes.</InlineNotice>}
      <div className="flex rounded-md border border-border-strong p-0.5 text-[12px]">
        {(['CURRENT', 'REACHED'] as const).map((s) => <button key={s} type="button" onClick={() => { setScope(s); setPage(1); }} className={cn('h-7 flex-1 rounded', scope === s ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{s === 'CURRENT' ? 'Here now' : 'Reached (incl. later)'}</button>)}
      </div>
      {!data ? <Skeleton className="h-60" /> : !data.rows.length ? <div className="py-8 text-center text-[12px] text-subtle">No leads here right now.</div> : (
        <ul className={cn('flex flex-col divide-y divide-border rounded-lg border border-border', isFetching && 'opacity-60')}>
          {data.rows.map((l) => (
            <li key={l.id}>
              <Link href={`/app/leads/${l.id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2">
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[10.5px] font-semibold">{l.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('')}</div>
                <div className="min-w-0 flex-1"><div className="truncate text-[12.5px] font-medium">{l.fullName}</div><div className="truncate text-[11px] text-subtle">{[l.company, l.owner?.name].filter(Boolean).join(' · ') || '—'}</div></div>
                <div className="text-right"><StatusBadge status={l.status} /><div className="tnum mt-0.5 text-[10.5px] text-subtle">{l.dealValue ? fmtMoney(l.dealValue, l.currency ?? 'USD') : `score ${l.score}`}</div></div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data && data.total > 12 && (
        <div className="flex items-center justify-between text-[11.5px] text-subtle">
          <span className="tnum">{fmtInt(data.total)} leads</span>
          <div className="flex items-center gap-1"><Button size="xs" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</Button><span className="tnum">{page}/{pages}</span><Button size="xs" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>
        </div>
      )}
    </div>
  );
}

function AutomationEditor({ a, canEmail, runs, onChange }: { a: Automation | null; canEmail: boolean; runs: number; onChange: (a: Automation | null) => void }) {
  const cur: Automation = a ?? { enabled: false, action: canEmail ? 'EMAIL' : 'TASK', templateId: null, taskTitle: null, dueInHours: 24, message: null, onlyNew: true };
  const set = (p: Partial<Automation>) => onChange({ ...cur, ...p });
  const templates = useApiQuery<{ templates: { id: string; name: string; subject: string }[] }>(canEmail && cur.action === 'EMAIL' ? '/api/v1/email/templates' : null);
  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-start justify-between gap-3 rounded-lg border border-border px-3.5 py-3">
        <div><div className="flex items-center gap-1.5 text-[13px] font-medium"><Zap className="size-3.5" />Act on every lead that enters this stage</div><div className="mt-0.5 text-[11.5px] text-subtle">Runs automatically every few minutes; each lead is handled once per stage.{runs ? ` ${fmtInt(runs)} leads handled so far.` : ''}</div></div>
        <Switch checked={cur.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label="Enable automation" />
      </label>
      <div className={cn('flex flex-col gap-4', !cur.enabled && 'pointer-events-none opacity-50')}>
        <div className="grid grid-cols-3 gap-1.5">
          {CHANNELS.map((c) => (
            <button key={c.key} type="button" disabled={c.key === 'EMAIL' && !canEmail} onClick={() => set({ action: c.key })} className={cn('flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-[11.5px] disabled:opacity-40', cur.action === c.key ? 'border-fg ring-1 ring-fg' : 'border-border-strong hover:border-fg/50')}>
              <c.icon className="size-4" />{c.key === 'EMAIL' ? 'Send email' : c.key === 'TASK' ? 'Create task' : 'Alert owner'}
            </button>
          ))}
        </div>
        {cur.action === 'EMAIL' && (
          <Field label="Email template" hint="Sent from your default sender">
            <Select value={cur.templateId ?? ''} onChange={(e) => set({ templateId: e.target.value || null })}><option value="">Choose a template…</option>{templates.data?.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
          </Field>
        )}
        {cur.action === 'TASK' && (
          <div className="grid grid-cols-[1fr_110px] gap-3">
            <Field label="Task"><Input value={cur.taskTitle ?? ''} maxLength={200} onChange={(e) => set({ taskTitle: e.target.value })} placeholder="Call to qualify" /></Field>
            <Field label="Due in (hours)"><Input type="number" min={0} max={720} value={cur.dueInHours} onChange={(e) => set({ dueInHours: Math.max(0, Math.min(720, Math.round(Number(e.target.value)))) })} /></Field>
          </div>
        )}
        {cur.action === 'NOTIFY' && <Field label="Message to the lead owner"><Textarea rows={2} maxLength={300} value={cur.message ?? ''} onChange={(e) => set({ message: e.target.value })} placeholder="A lead just reached this stage — follow up today." /></Field>}
        <label className="flex items-center justify-between gap-3 text-[12.5px]">
          <span>Only new arrivals<span className="block text-[11.5px] text-subtle">Leads already in the stage when you switch this on are skipped</span></span>
          <Switch checked={cur.onlyNew} onCheckedChange={(v) => set({ onlyNew: v })} aria-label="Only new arrivals" />
        </label>
      </div>
      <p className="text-[11px] text-subtle">Remember to save the funnel to apply automation changes.</p>
    </div>
  );
}

function LaunchDialog({ funnelId, stage, canEmail, onClose, onDone }: { funnelId: string; stage: Stage; canEmail: boolean; onClose: () => void; onDone: () => void }) {
  const [scope, setScope] = useState<'CURRENT' | 'REACHED'>('CURRENT');
  const [channel, setChannel] = useState<Action>(canEmail ? 'EMAIL' : 'TASK');
  const [name, setName] = useState(`${stage.name} push`);
  const [email, setEmail] = useState({ smtpAccountId: '', templateId: '', subject: '' });
  const [task, setTask] = useState({ title: `Follow up: ${stage.name}`, dueInHours: 24 });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const aud = useApiQuery<{ total: number; withEmail: number; owned: number }>(`/api/v1/crm/funnels/${funnelId}/audience?stageId=${stage.id}&scope=${scope}`);
  const senders = useApiQuery<{ accounts: { id: string; label: string; fromEmail: string; status: string; isDefault: boolean }[] }>(canEmail ? '/api/v1/email/smtp' : null);
  const templates = useApiQuery<{ templates: { id: string; name: string; subject: string }[] }>(canEmail ? '/api/v1/email/templates' : null);
  useEffect(() => {
    const d = senders.data?.accounts.find((a) => a.isDefault) ?? senders.data?.accounts[0];
    if (d) setEmail((e) => (e.smtpAccountId ? e : { ...e, smtpAccountId: d.id }));
  }, [senders.data]);
  const reach = channel === 'EMAIL' ? aud.data?.withEmail : aud.data?.total;
  const ready = name.trim().length >= 2 && (reach ?? 0) > 0 && (channel !== 'EMAIL' || (email.smtpAccountId && email.templateId)) && (channel !== 'TASK' || task.title.trim().length >= 2) && (channel !== 'NOTIFY' || message.trim().length >= 2);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ recipients: number }>(`/api/v1/crm/funnels/${funnelId}/campaigns`, { body: { stageId: stage.id, scope, channel, name, email: channel === 'EMAIL' ? { ...email, subject: email.subject || undefined } : undefined, task: channel === 'TASK' ? task : undefined, notify: channel === 'NOTIFY' ? { message } : undefined } });
      toast.success(channel === 'EMAIL' ? `Sending to ${fmtInt(r.recipients)} leads` : channel === 'TASK' ? `${fmtInt(r.recipients)} tasks created` : 'Team alerted');
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Launch campaign · ${stage.name}`} description="Reaches the leads in this stage right now. Use automations to also catch leads that arrive later." size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!ready} onClick={submit}><Megaphone /> Launch to {fmtInt(reach ?? 0)} lead{reach === 1 ? '' : 's'}</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {CHANNELS.map((c) => (
            <button key={c.key} type="button" disabled={c.key === 'EMAIL' && !canEmail} onClick={() => setChannel(c.key)} className={cn('flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left disabled:opacity-40', channel === c.key ? 'border-fg ring-1 ring-fg' : 'border-border-strong hover:border-fg/50')}>
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium"><c.icon className="size-3.5" />{c.label}</span><span className="text-[11px] leading-snug text-subtle">{c.hint}</span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <Field label="Campaign name"><Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Audience">
            <div className="flex h-8 rounded-md border border-border-strong p-0.5 text-[12px]">
              {(['CURRENT', 'REACHED'] as const).map((s) => <button key={s} type="button" onClick={() => setScope(s)} className={cn('rounded px-2.5', scope === s ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{s === 'CURRENT' ? 'Here now' : 'Here + later stages'}</button>)}
            </div>
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-2 rounded-lg bg-surface-2 px-4 py-3 text-center">
          <div><div className="tnum text-[18px] font-semibold">{aud.data ? fmtInt(aud.data.total) : '…'}</div><div className="text-[11px] text-subtle">leads</div></div>
          <div><div className="tnum text-[18px] font-semibold">{aud.data ? fmtInt(aud.data.withEmail) : '…'}</div><div className="text-[11px] text-subtle">with email</div></div>
          <div><div className="tnum text-[18px] font-semibold">{aud.data ? fmtInt(aud.data.owned) : '…'}</div><div className="text-[11px] text-subtle">have an owner</div></div>
        </div>
        {channel === 'EMAIL' && (
          senders.data && !senders.data.accounts.length ? <InlineNotice tone="warn">Add a sender in <Link className="underline" href="/app/email">Email</Link> first. <ExternalLink className="inline size-3" /></InlineNotice> : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Send from"><Select value={email.smtpAccountId} onChange={(e) => setEmail({ ...email, smtpAccountId: e.target.value })}>{senders.data?.accounts.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.fromEmail}</option>)}</Select></Field>
              <Field label="Template"><Select value={email.templateId} onChange={(e) => setEmail({ ...email, templateId: e.target.value, subject: templates.data?.templates.find((t) => t.id === e.target.value)?.subject ?? '' })}><option value="">Choose…</option>{templates.data?.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
              <Field label="Subject" className="sm:col-span-2"><Input value={email.subject} maxLength={300} onChange={(e) => setEmail({ ...email, subject: e.target.value })} placeholder="Uses the template subject" /></Field>
            </div>
          )
        )}
        {channel === 'TASK' && (
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Field label="Task title"><Input value={task.title} maxLength={200} onChange={(e) => setTask({ ...task, title: e.target.value })} /></Field>
            <Field label="Due in (hours)"><Input type="number" min={0} max={720} value={task.dueInHours} onChange={(e) => setTask({ ...task, dueInHours: Math.max(0, Math.min(720, Math.round(Number(e.target.value)))) })} /></Field>
          </div>
        )}
        {channel === 'NOTIFY' && <Field label="Message"><Textarea rows={3} maxLength={300} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="These leads are ready for a proposal — reach out this week." /></Field>}
      </div>
    </Dialog>
  );
}
