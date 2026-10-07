'use client';
import type { ColumnDef } from '@tanstack/react-table';
import {
  ArrowLeft, ArrowRight, Building2, CalendarClock, Check, CheckCircle2, Filter, Globe, History, Info, Layers, Loader2, RotateCcw, Search, Shuffle, SlidersHorizontal, Sparkles, Target, Users, X,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DataTable, emptySelection, selectionCount, type SelectionState } from '@/components/data/data-table';
import { FilterBuilder } from '@/components/data/filter-builder';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Switch, Tooltip } from '@/components/ui/overlay';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import type { Condition, Selection } from '@/lib/filters';
import { fmtAgo, fmtInt, fmtPct } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { leadFields } from '../leads/lead-repository';
import { findCond, MultiFilter, RangeFilter, setCond, TimesFilter, type Facets } from '@/components/data/quick-filters';
import { STRATEGY_INFO } from './strategies';

type Lead = { id: string; fullName: string; company: string | null; email: string | null; country: string | null; city: string | null; industry: string | null; source: string | null; campaign: string | null; score: number; quality: string; allocationStatus: string; assignedOrganization: string | null; distributionCount: number; lastDistributedAt: string | null; createdAt: string };
type Target = { organizationId: string; name: string; code: string | null; industry: string | null; domain: string | null; status: string; eligible: boolean; reason: string | null; capacity: number | null; weight: number; active: number; today: number; lifetime: number; lastReceived: string | null; quota: { maxActiveLeads: number; dailyAllocationLimit: number } | null; regions: string[]; industries: string[]; campaigns: string[]; minScore: number | null; maxScore: number | null };
type Insight = { selected: number; eligible: number; skipped: Record<string, number>; neverDistributed: number; previouslyDistributed: number; avgScore: number; top: Record<'countries' | 'industries' | 'campaigns', { label: string; count: number }[]>; clients: { organizationId: string; matches: Record<string, number>; hadBefore: number }[] };
type Preview = { selected: number; eligible: number; planned: number; redistributed: number; skipped: Record<string, number>; unassigned: Record<string, number>; largeBatch: boolean; largeBatchThreshold: number; targets: { organizationId: string; name: string; eligible: boolean; reason: string | null; capacity: number | null; planned: number; requested: number | null; sample: { id: string; fullName: string; company: string | null; country: string | null; industry: string | null; distributionCount: number }[] }[] };

const STEPS = [
  { key: 1, label: 'Pick leads', icon: Users },
  { key: 2, label: 'Choose clients', icon: Building2 },
  { key: 3, label: 'How to split', icon: Shuffle },
  { key: 4, label: 'Review & send', icon: CheckCircle2 },
] as const;

const READY: Condition[] = [{ field: 'allocationStatus', op: 'in', value: ['UNALLOCATED'] }, { field: 'quality', op: 'in', value: ['VALID'] }];
const PRESETS: { key: string; label: string; hint: string; build: (f?: Facets) => Condition[] }[] = [
  { key: 'ready', label: 'Ready to distribute', hint: 'Unallocated, valid contact data', build: () => READY },
  { key: 'never', label: 'Never distributed', hint: 'Fresh leads no client has seen', build: () => [...READY, { field: 'distributionCount', op: 'eq', value: 0 }] },
  { key: 'returned', label: 'Returned leads', hint: 'Came back from a client — redistribute', build: () => [...READY, { field: 'distributionCount', op: 'gte', value: 1 }] },
  { key: 'week', label: 'Added this week', hint: 'Created in the last 7 days', build: () => [...READY, { field: 'createdAt', op: 'last_days', value: 7 }] },
  { key: 'hot', label: 'High score', hint: 'Score 70 and above', build: () => [...READY, { field: 'score', op: 'gte', value: 70 }] },
  { key: 'import', label: 'Latest import', hint: 'From the most recent file', build: (f) => [...READY, ...(f?.imports[0] ? [{ field: 'importBatchId', op: 'in', value: [f.imports[0].id] }] : [])] },
];

const STRATEGY_GROUPS: { title: string; hint: string; items: string[] }[] = [
  { title: 'Simple', hint: 'Most common', items: ['EQUAL', 'CUSTOM', 'WEIGHTED'] },
  { title: 'Smart matching', hint: 'Send each lead to clients that want it', items: ['GEOGRAPHY', 'INDUSTRY', 'CAMPAIGN', 'SCORE'] },
  { title: 'Capacity-based', hint: 'Balance by room left', items: ['CAPACITY', 'QUOTA', 'ROUND_ROBIN'] },
];
const MATCH_FOR: Record<string, string> = { GEOGRAPHY: 'region', INDUSTRY: 'industry', CAMPAIGN: 'campaign', SCORE: 'score range' };

type Draft = { step: number; conditions: Condition[]; q: string; all: boolean; ids: string[]; excluded: string[]; picked: Record<string, { quantity?: number; weight?: number }>; strategy: string; respectQuotas: boolean; includeInvalid: boolean; avoidPrevious: boolean; schedule: boolean; scheduledFor: string; note: string };
const DRAFT_KEY = 'lcrm.distribution.draft';

export function DistributeWizard() {
  const router = useRouter();
  const sp = useSearchParams();
  const facets = useApiQuery<Facets>('/api/v1/leads/facets');
  const targetsQ = useApiQuery<{ targets: Target[] }>('/api/v1/distribution/targets');

  const [step, setStep] = useState(1);
  const [conditions, setConditions] = useState<Condition[]>(READY);
  const [q, setQ] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [sel, setSel] = useState<SelectionState>(emptySelection());
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ id: string; desc: boolean } | null>(null);
  const [picked, setPicked] = useState<Draft['picked']>({});
  const [strategy, setStrategy] = useState('EQUAL');
  const [respectQuotas, setRespectQuotas] = useState(true);
  const [includeInvalid, setIncludeInvalid] = useState(false);
  const [avoidPrevious, setAvoidPrevious] = useState(true);
  const [schedule, setSchedule] = useState(false);
  const [scheduledFor, setScheduledFor] = useState('');
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const idem = useRef(typeof crypto !== 'undefined' ? crypto.randomUUID() : String(Date.now()));
  const loaded = useRef(false);
  /** Set when a selection is restored together with its filters, so the filter-change reset is skipped once. */
  const restoring = useRef(false);

  // ── Draft restore / handoff from the lead repository ──
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    try {
      if (sp.get('from') === 'leads') {
        const raw = sessionStorage.getItem('lcrm.distribution.selection');
        sessionStorage.removeItem('lcrm.distribution.selection');
        if (raw) {
          restoring.current = true;
          const { selection } = JSON.parse(raw) as { selection: Selection };
          if (selection.mode === 'ids') { setConditions([]); setSel({ all: false, ids: new Set(selection.ids), excluded: new Set() }); }
          else { setConditions(selection.filter.conditions); setQ(selection.filter.q ?? ''); setSel({ all: true, ids: new Set(), excluded: new Set(selection.excludeIds) }); }
          return;
        }
      }
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as Draft;
      restoring.current = true;
      setStep(d.step); setConditions(d.conditions); setQ(d.q); setSel({ all: d.all, ids: new Set(d.ids), excluded: new Set(d.excluded) });
      setPicked(d.picked); setStrategy(d.strategy); setRespectQuotas(d.respectQuotas); setIncludeInvalid(d.includeInvalid); setAvoidPrevious(d.avoidPrevious);
      setSchedule(d.schedule); setScheduledFor(d.scheduledFor); setNote(d.note);
    } catch {}
  }, [sp]);
  useEffect(() => {
    if (!loaded.current) return;
    const d: Draft = { step, conditions, q, all: sel.all, ids: [...sel.ids], excluded: [...sel.excluded], picked, strategy, respectQuotas, includeInvalid, avoidPrevious, schedule, scheduledFor, note };
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch {}
  }, [step, conditions, q, sel, picked, strategy, respectQuotas, includeInvalid, avoidPrevious, schedule, scheduledFor, note]);

  const filter = useMemo(() => ({ q: q.trim() || undefined, conditions }), [q, conditions]);
  const filterKey = JSON.stringify(filter);
  const list = useApiQuery<{ total: number; rows: Lead[] }>(`/api/v1/leads?page=${page}&pageSize=25&view=active&filter=${encodeURIComponent(filterKey)}${sort ? `&sort=${encodeURIComponent(JSON.stringify(sort))}` : ''}`);
  const total = list.data?.total ?? 0;
  const count = selectionCount(sel, total);
  const selection: Selection | null = sel.all
    ? { mode: 'filter', filter, excludeIds: [...sel.excluded] }
    : sel.ids.size ? { mode: 'ids', ids: [...sel.ids] } : null;
  // Filters changed → a "select all matching" selection no longer means the same leads.
  const prevFilter = useRef(filterKey);
  useEffect(() => {
    if (prevFilter.current === filterKey) return;
    prevFilter.current = filterKey;
    if (restoring.current) { restoring.current = false; return; }
    setPage(1);
    setSel((s) => (s.all ? emptySelection() : s));
  }, [filterKey]);

  const selectionKey = JSON.stringify([selection, includeInvalid]);
  const [insight, setInsight] = useState<{ key: string; data: Insight } | null>(null);
  const [insightBusy, setInsightBusy] = useState(false);
  useEffect(() => {
    if (step < 2 || !selection || insight?.key === selectionKey) return;
    setInsightBusy(true);
    api<Insight>('/api/v1/distribution/insight', { body: { selection, includeInvalid } })
      .then((data) => setInsight({ key: selectionKey, data }))
      .catch((e) => toast.error(errorMessage(e)))
      .finally(() => setInsightBusy(false));
  }, [step, selectionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const targets = useMemo(() => Object.entries(picked).map(([organizationId, v]) => ({ organizationId, ...(strategy === 'CUSTOM' ? { quantity: v.quantity ?? 0 } : {}), ...(strategy === 'WEIGHTED' && v.weight != null ? { weight: v.weight } : {}) })), [picked, strategy]);
  const body = selection ? { selection, strategy, targets, respectQuotas, includeInvalid, avoidPreviousClients: avoidPrevious } : null;
  const bodyKey = JSON.stringify(body);
  const [preview, setPreview] = useState<{ key: string; data: Preview } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (step < 3 || !body || !targets.length || preview?.key === bodyKey) return;
    const t = setTimeout(() => {
      setPreviewBusy(true);
      setPreviewError(null);
      api<Preview>('/api/v1/distribution/preview', { body })
        .then((data) => setPreview({ key: bodyKey, data }))
        .catch((e) => setPreviewError(errorMessage(e)))
        .finally(() => setPreviewBusy(false));
    }, 350);
    return () => clearTimeout(t);
  }, [step, bodyKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pv = preview?.key === bodyKey ? preview.data : null;

  const canNext = step === 1 ? count > 0 : step === 2 ? targets.length > 0 : step === 3 ? !(strategy === 'CUSTOM' && targets.every((t) => !t.quantity)) : false;
  const go = (n: number) => { if (n < step || (n === step + 1 && canNext) || n <= maxReachable) setStep(n); };
  const maxReachable = count === 0 ? 1 : !targets.length ? 2 : 4;

  const reset = () => {
    try { sessionStorage.removeItem(DRAFT_KEY); } catch {}
    setStep(1); setConditions(READY); setQ(''); setSel(emptySelection()); setPicked({}); setStrategy('EQUAL'); setRespectQuotas(true); setIncludeInvalid(false); setAvoidPrevious(true); setSchedule(false); setScheduledFor(''); setNote('');
    idem.current = crypto.randomUUID();
  };

  const submit = async () => {
    const res = await api<{ batch: { id: string } }>('/api/v1/distribution/batches', {
      body: { ...body, idempotencyKey: idem.current, confirmLarge: true, note: note || undefined, scheduledFor: schedule && scheduledFor ? new Date(scheduledFor).toISOString() : null },
    });
    try { sessionStorage.removeItem(DRAFT_KEY); } catch {}
    router.push(`/admin/distribution/batches/${res.batch.id}`);
  };

  return (
    <div className="flex flex-col gap-4 pb-20">
      {/* Stepper */}
      <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-1.5 shadow-[var(--card-shadow)]">
        {STEPS.map((s, i) => {
          const done = step > s.key;
          const reachable = s.key <= Math.max(step, maxReachable);
          return (
            <div key={s.key} className="flex items-center">
              {i > 0 && <span className={cn('mx-1 h-px w-6 shrink-0', done || step >= s.key ? 'bg-fg' : 'bg-border-strong')} />}
              <button type="button" disabled={!reachable} onClick={() => go(s.key)}
                className={cn('flex items-center gap-2 rounded-md px-3 py-1.5 text-[12.5px] whitespace-nowrap transition-colors disabled:opacity-40', step === s.key ? 'bg-fg text-inverse' : 'text-muted hover:bg-surface-3 hover:text-fg')}>
                <span className={cn('grid size-5 place-items-center rounded-full border text-[10.5px] font-semibold', step === s.key ? 'border-inverse/40' : done ? 'border-fg bg-fg text-inverse' : 'border-border-strong')}>{done ? <Check className="size-3" /> : s.key}</span>
                {s.label}
              </button>
            </div>
          );
        })}
        <Button size="sm" variant="ghost" className="ml-auto shrink-0" onClick={reset}><RotateCcw /> Start over</Button>
      </div>

      {step === 1 && (
        <StepLeads
          facets={facets.data} conditions={conditions} setConditions={setConditions} q={q} setQ={setQ} advanced={advanced} setAdvanced={setAdvanced}
          rows={list.data?.rows ?? []} total={total} loading={list.isFetching} page={page} setPage={setPage} sort={sort} setSort={setSort} sel={sel} setSel={setSel}
        />
      )}
      {step === 2 && (
        <StepClients targets={targetsQ.data?.targets} insight={insight?.key === selectionKey ? insight.data : null} insightBusy={insightBusy} picked={picked} setPicked={setPicked} />
      )}
      {step === 3 && (
        <StepSplit
          strategy={strategy} setStrategy={setStrategy} picked={picked} setPicked={setPicked} targets={targetsQ.data?.targets ?? []} insight={insight?.key === selectionKey ? insight.data : null}
          options={{ respectQuotas, setRespectQuotas, includeInvalid, setIncludeInvalid, avoidPrevious, setAvoidPrevious, schedule, setSchedule, scheduledFor, setScheduledFor, note, setNote }}
          preview={pv} busy={previewBusy} error={previewError}
        />
      )}
      {step === 4 && <StepReview preview={pv} busy={previewBusy} error={previewError} count={count} strategy={strategy} schedule={schedule ? scheduledFor : null} avoidPrevious={avoidPrevious} respectQuotas={respectQuotas} />}

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur lg:left-[232px]">
        <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-2.5 md:px-6">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
            <span className="flex items-center gap-1.5"><Users className="size-3.5 text-subtle" /><b className="tnum font-semibold">{fmtInt(count)}</b> lead{count === 1 ? '' : 's'} selected{sel.all && <span className="text-subtle">(all matching)</span>}</span>
            {targets.length > 0 && <span className="flex items-center gap-1.5"><Building2 className="size-3.5 text-subtle" /><b className="tnum font-semibold">{targets.length}</b> client{targets.length === 1 ? '' : 's'}</span>}
            {step >= 3 && <span className="flex items-center gap-1.5"><Shuffle className="size-3.5 text-subtle" />{STRATEGY_INFO[strategy]?.label}</span>}
            {pv && step >= 3 && <span className="flex items-center gap-1.5 text-fg"><Target className="size-3.5 text-subtle" /><b className="tnum font-semibold">{fmtInt(pv.planned)}</b> will be sent</span>}
          </div>
          {step > 1 && <Button variant="ghost" onClick={() => setStep(step - 1)}><ArrowLeft /> Back</Button>}
          {step < 4 ? (
            <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>{step === 1 ? 'Choose clients' : step === 2 ? 'How to split' : 'Review'} <ArrowRight /></Button>
          ) : (
            <Button variant="primary" disabled={!pv?.planned || previewBusy || (schedule && !scheduledFor)} onClick={() => setConfirm(true)}>{schedule ? <><CalendarClock /> Schedule</> : <><Check /> Distribute {pv ? fmtInt(pv.planned) : ''} leads</>}</Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm} onOpenChange={setConfirm} title={schedule ? 'Schedule distribution' : 'Confirm distribution'} confirmLabel={schedule ? 'Schedule' : 'Distribute'}
        typed={pv?.largeBatch ? `ALLOCATE ${pv.planned}` : undefined}
        description={`${fmtInt(pv?.planned ?? 0)} leads will be reserved now and sent to ${pv?.targets.filter((t) => t.planned).length ?? 0} client(s) ${schedule ? `at ${scheduledFor.replace('T', ' ')}` : 'immediately'}. Quotas are re-checked when it runs, and the batch can be rolled back.`}
        onConfirm={submit}
      />
    </div>
  );
}

// ── Step 1: leads ────────────────────────────────────────────────────

function StepLeads({ facets, conditions, setConditions, q, setQ, advanced, setAdvanced, rows, total, loading, page, setPage, sort, setSort, sel, setSel }: {
  facets?: Facets; conditions: Condition[]; setConditions: (c: Condition[]) => void; q: string; setQ: (q: string) => void; advanced: boolean; setAdvanced: (b: boolean) => void;
  rows: Lead[]; total: number; loading: boolean; page: number; setPage: (p: number) => void; sort: { id: string; desc: boolean } | null; setSort: (s: { id: string; desc: boolean } | null) => void; sel: SelectionState; setSel: (s: SelectionState) => void;
}) {
  const opt = (xs: string[]) => xs.map((v) => ({ value: v, label: v }));
  const preset = PRESETS.find((p) => JSON.stringify(p.build(facets)) === JSON.stringify(conditions))?.key;
  const fields = useMemo(() => leadFields(facets), [facets]);
  const onlyReady = Boolean(findCond(conditions, 'allocationStatus')) && JSON.stringify(findCond(conditions, 'allocationStatus')?.value) === JSON.stringify(['UNALLOCATED']);
  const columns: ColumnDef<Lead, unknown>[] = [
    { id: 'fullName', header: 'Lead', enableSorting: true, cell: ({ row: { original: r } }) => <div className="min-w-[170px]"><div className="text-fg">{r.fullName}</div><div className="truncate text-[11px] text-subtle">{r.company ?? '—'}{r.email ? ` · ${r.email}` : ''}</div></div> },
    { id: 'country', header: 'Location', enableSorting: true, cell: ({ row: { original: r } }) => <span className="text-muted">{[r.city, r.country].filter(Boolean).join(', ') || '—'}</span> },
    { id: 'industry', header: 'Industry', enableSorting: true, cell: ({ row: { original: r } }) => <span className="text-muted">{r.industry ?? '—'}</span> },
    { id: 'source', header: 'Source', enableSorting: true, cell: ({ row: { original: r } }) => <div><div className="text-muted">{r.source ?? '—'}</div>{r.campaign && <div className="max-w-[160px] truncate text-[11px] text-subtle">{r.campaign}</div>}</div> },
    { id: 'score', header: 'Score', enableSorting: true, cell: ({ row: { original: r } }) => <span className="tnum">{r.score}</span> },
    { id: 'status', header: 'Status', cell: ({ row: { original: r } }) => <span className="flex items-center gap-1">{r.quality === 'INVALID' ? <Badge tone="warn">Invalid</Badge> : <StatusBadge status={r.allocationStatus} />}</span> },
    {
      id: 'distributionCount', header: 'Distributed', enableSorting: true,
      cell: ({ row: { original: r } }) => r.distributionCount ? (
        <Tooltip content={`Sent to clients ${r.distributionCount} time${r.distributionCount === 1 ? '' : 's'}${r.lastDistributedAt ? ` · last ${fmtAgo(r.lastDistributedAt)}` : ''}${r.assignedOrganization ? ` · now with ${r.assignedOrganization}` : ''}`}>
          <span className="inline-flex items-center gap-1"><Badge tone="outline">{r.distributionCount}×</Badge>{r.assignedOrganization && <span className="max-w-[110px] truncate text-[11px] text-subtle">{r.assignedOrganization}</span>}</span>
        </Tooltip>
      ) : <Badge tone="dim">Never</Badge>,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {PRESETS.map((p) => (
          <button key={p.key} type="button" onClick={() => setConditions(p.build(facets))}
            className={cn('rounded-lg border px-3 py-2.5 text-left transition-all', preset === p.key ? 'border-fg bg-surface shadow-[var(--raised-shadow)] ring-1 ring-fg' : 'border-border bg-surface hover:border-border-strong')}>
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium">{preset === p.key && <Check className="size-3.5" />}{p.label}</div>
            <div className="text-[11px] leading-snug text-subtle">{p.hint}</div>
          </button>
        ))}
      </div>

      <DataTable
        columns={columns} data={rows} total={total} page={page} pageSize={25} onPage={setPage} loading={loading} getRowId={(r) => r.id}
        sort={sort} onSort={setSort} selection={sel} onSelection={setSel}
        empty={<div className="py-10 text-center text-[12.5px] text-subtle">No leads match these filters.</div>}
        toolbar={
          <div className="flex w-full flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full max-w-[260px]"><Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, company, email, phone" className="h-7 pl-8 text-[12px]" /></div>
              <MultiFilter label="Country" field="country" options={opt(facets?.countries ?? [])} conditions={conditions} onChange={setConditions} negatable />
              <MultiFilter label="Industry" field="industry" options={opt(facets?.industries ?? [])} conditions={conditions} onChange={setConditions} negatable />
              <MultiFilter label="Source" field="source" options={opt(facets?.sources ?? [])} conditions={conditions} onChange={setConditions} negatable />
              <MultiFilter label="Campaign" field="campaign" options={opt(facets?.campaigns ?? [])} conditions={conditions} onChange={setConditions} />
              <MultiFilter label="Import" field="importBatchId" options={(facets?.imports ?? []).map((i) => ({ value: i.id, label: `${i.code} · ${i.fileName}` }))} conditions={conditions} onChange={setConditions} />
              <RangeFilter label="Score" field="score" conditions={conditions} onChange={setConditions} />
              <MultiFilter label="Never sent to" field="everClient" options={(facets?.orgs ?? []).map((o) => ({ value: o.id, label: o.name }))} conditions={conditions.map((c) => (c.field === 'everClient' && c.op === 'not_in' ? { ...c, op: 'in' } : c))} onChange={(cs) => setConditions(cs.map((c) => (c.field === 'everClient' ? { ...c, op: 'not_in' } : c)))} />
              <TimesFilter conditions={conditions} onChange={setConditions} />
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[12px]">
              <label className="flex items-center gap-2 text-muted"><Switch checked={onlyReady} onCheckedChange={(v) => setConditions(setCond(conditions, 'allocationStatus', v ? { field: 'allocationStatus', op: 'in', value: ['UNALLOCATED'] } : null))} aria-label="Only unallocated" />Only unallocated leads</label>
              <button type="button" onClick={() => setAdvanced(!advanced)} className={cn('flex items-center gap-1.5', advanced ? 'text-fg' : 'text-muted hover:text-fg')}><SlidersHorizontal className="size-3.5" />Advanced filters{conditions.length ? ` (${conditions.length})` : ''}</button>
              {(conditions.length > 0 || q) && <button type="button" onClick={() => { setConditions([]); setQ(''); }} className="flex items-center gap-1 text-subtle hover:text-fg"><X className="size-3" />Clear all</button>}
              <span className="ml-auto text-subtle"><b className="tnum font-medium text-fg">{fmtInt(total)}</b> matching</span>
            </div>
            {advanced && <div className="rounded-md border border-border bg-surface-2 p-3"><FilterBuilder fields={fields} value={conditions} onChange={setConditions} /></div>}
          </div>
        }
      />
      {selectionCount(sel, total) === 0 && total > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border-strong px-4 py-3 text-[12.5px] text-muted">
          <span className="flex items-center gap-2"><Info className="size-3.5" />Tick leads in the table, or take everything that matches your filters.</span>
          <Button size="sm" variant="primary" onClick={() => setSel({ all: true, ids: new Set(), excluded: new Set() })}><Layers /> Select all {fmtInt(total)} matching</Button>
        </div>
      )}
    </div>
  );
}

// ── Step 2: clients ──────────────────────────────────────────────────

function StepClients({ targets, insight, insightBusy, picked, setPicked }: { targets?: Target[]; insight: Insight | null; insightBusy: boolean; picked: Draft['picked']; setPicked: React.Dispatch<React.SetStateAction<Draft['picked']>> }) {
  const [q, setQ] = useState('');
  const [industry, setIndustry] = useState('');
  const [sortBy, setSortBy] = useState<'match' | 'headroom' | 'name' | 'lifetime'>('match');
  const ins = new Map((insight?.clients ?? []).map((c) => [c.organizationId, c]));
  const bestMatch = (id: string) => Math.max(0, ...Object.values(ins.get(id)?.matches ?? {}));
  const industries = [...new Set((targets ?? []).map((t) => t.industry ?? 'Unspecified'))].sort();
  const list = (targets ?? [])
    .filter((t) => (!q || `${t.name} ${t.domain ?? ''} ${t.code ?? ''}`.toLowerCase().includes(q.toLowerCase())) && (!industry || (t.industry ?? 'Unspecified') === industry))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || (sortBy === 'name' ? a.name.localeCompare(b.name) : sortBy === 'headroom' ? (b.capacity ?? 1e9) - (a.capacity ?? 1e9) : sortBy === 'lifetime' ? b.lifetime - a.lifetime : bestMatch(b.organizationId) - bestMatch(a.organizationId)));
  const toggle = (t: Target, on: boolean) => setPicked((prev) => {
    const n = { ...prev };
    if (on) n[t.organizationId] = { weight: t.weight };
    else delete n[t.organizationId];
    return n;
  });
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      <SelectionSummary insight={insight} busy={insightBusy} />
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-[240px]"><Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients or domains" className="h-8 pl-8 text-[12px]" /></div>
          <Select value={industry} onChange={(e) => setIndustry(e.target.value)} className="h-8 w-48 text-[12px]" aria-label="Client domain"><option value="">All client domains</option>{industries.map((i) => <option key={i}>{i}</option>)}</Select>
          <Select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} className="h-8 w-44 text-[12px]" aria-label="Sort clients"><option value="match">Best match first</option><option value="headroom">Most room first</option><option value="lifetime">Most leads received</option><option value="name">Name</option></Select>
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setPicked(Object.fromEntries(list.filter((t) => t.eligible).map((t) => [t.organizationId, { weight: t.weight }])))}>Select all eligible{q || industry ? ' (shown)' : ''}</Button>
            {Object.keys(picked).length > 0 && <Button size="sm" variant="ghost" onClick={() => setPicked({})}>Clear</Button>}
          </span>
        </div>
        {!targets ? <Skeleton className="h-64" /> : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {list.map((t) => {
              const on = t.organizationId in picked;
              const i = ins.get(t.organizationId);
              const util = t.quota ? t.active / Math.max(1, t.quota.maxActiveLeads) : null;
              const profile = [t.regions.length && `${t.regions.slice(0, 3).join(', ')}${t.regions.length > 3 ? '…' : ''}`, t.industries.length && t.industries.slice(0, 2).join(', ')].filter(Boolean).join(' · ');
              return (
                <button key={t.organizationId} type="button" disabled={!t.eligible} onClick={() => toggle(t, !on)} aria-pressed={on}
                  className={cn('group flex flex-col rounded-lg border bg-surface p-3.5 text-left transition-all disabled:cursor-not-allowed disabled:opacity-55', on ? 'border-fg shadow-[var(--raised-shadow)] ring-1 ring-fg' : 'border-border hover:border-border-strong hover:shadow-[var(--card-shadow)]')}>
                  <div className="flex items-start gap-2.5">
                    <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border', on ? 'border-fg bg-fg text-inverse' : 'border-faint')}>{on && <Check className="size-3" strokeWidth={3} />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{t.name}</span>
                      <span className="flex items-center gap-1.5 truncate text-[11px] text-subtle">{t.domain ? <><Globe className="size-3" />{t.domain}</> : t.code}{t.industry && <> · {t.industry}</>}</span>
                    </span>
                    {t.eligible ? <StatusBadge status={t.status} /> : <Badge tone="warn">{t.reason}</Badge>}
                  </div>
                  <div className="mt-3">
                    <div className="mb-1 flex justify-between text-[11px] text-subtle"><span>{fmtInt(t.active)} active{t.quota ? ` of ${fmtInt(t.quota.maxActiveLeads)}` : ''}</span><span>{t.capacity == null ? 'no limit' : `${fmtInt(t.capacity)} room left`}</span></div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-fg transition-all" style={{ width: `${Math.min(100, (util ?? 0) * 100)}%` }} /></div>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
                    <span>{fmtInt(t.lifetime)} received all-time</span>
                    <span>{fmtInt(t.today)} today</span>
                    {t.lastReceived && <span>last {fmtAgo(t.lastReceived)}</span>}
                  </div>
                  {i && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {Object.entries(i.matches).filter(([, n]) => n > 0).map(([k, n]) => <Badge key={k} tone="outline">{fmtInt(n)} match {MATCH_FOR[k]}</Badge>)}
                      {i.hadBefore > 0 && <Badge tone="warn"><History className="size-3" />had {fmtInt(i.hadBefore)} before</Badge>}
                    </div>
                  )}
                  {profile && <div className="mt-2 truncate text-[10.5px] text-subtle">Wants: {profile}</div>}
                </button>
              );
            })}
            {!list.length && <div className="col-span-full py-10 text-center text-[12.5px] text-subtle">No clients match.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function SelectionSummary({ insight, busy }: { insight: Insight | null; busy: boolean }) {
  return (
    <Card className="self-start xl:sticky xl:top-20">
      <CardHeader title="Your selection" description="What you're about to distribute" actions={busy ? <Loader2 className="size-3.5 animate-spin text-subtle" /> : null} />
      <CardBody className="flex flex-col gap-4">
        {!insight ? <Skeleton className="h-40" /> : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Tile label="Selected" value={insight.selected} />
              <Tile label="Can be sent" value={insight.eligible} strong />
              <Tile label="Never distributed" value={insight.neverDistributed} />
              <Tile label="Distributed before" value={insight.previouslyDistributed} />
            </div>
            {Object.keys(insight.skipped).length > 0 && (
              <div className="rounded-md border border-border px-3 py-2 text-[11.5px]">
                <div className="mb-1 flex items-center gap-1 text-subtle"><Info className="size-3" /> Will be skipped</div>
                {Object.entries(insight.skipped).map(([r, n]) => <div key={r} className="flex justify-between text-muted"><span>{r}</span><span className="tnum">{fmtInt(n)}</span></div>)}
                {insight.skipped['Invalid contact data'] && <div className="mt-1.5 text-subtle">You can include invalid leads in the next step if a client wants them.</div>}
              </div>
            )}
            {(['countries', 'industries'] as const).map((k) => insight.top[k].length > 0 && (
              <div key={k}>
                <div className="eyebrow mb-1.5">Top {k}</div>
                {insight.top[k].map((x) => (
                  <div key={x.label} className="mb-1">
                    <div className="flex justify-between text-[11.5px]"><span className="truncate text-muted">{x.label}</span><span className="tnum">{fmtInt(x.count)}</span></div>
                    <div className="mt-0.5 h-1 rounded-full bg-surface-3"><div className="h-full rounded-full bg-fg/70" style={{ width: `${(x.count / Math.max(1, insight.eligible)) * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            ))}
            <div className="text-[11.5px] text-subtle">Average score <b className="tnum font-medium text-fg">{insight.avgScore}</b></div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

const Tile = ({ label, value, strong }: { label: string; value: number; strong?: boolean }) => (
  <div className={cn('rounded-md border px-2.5 py-2', strong ? 'border-fg/50' : 'border-border')}>
    <div className="tnum text-[17px] font-semibold tracking-[-0.02em]">{fmtInt(value)}</div>
    <div className="text-[10.5px] text-subtle">{label}</div>
  </div>
);

// ── Step 3: split ────────────────────────────────────────────────────

type Opts = { respectQuotas: boolean; setRespectQuotas: (b: boolean) => void; includeInvalid: boolean; setIncludeInvalid: (b: boolean) => void; avoidPrevious: boolean; setAvoidPrevious: (b: boolean) => void; schedule: boolean; setSchedule: (b: boolean) => void; scheduledFor: string; setScheduledFor: (s: string) => void; note: string; setNote: (s: string) => void };

function StepSplit({ strategy, setStrategy, picked, setPicked, targets, insight, options: o, preview, busy, error }: {
  strategy: string; setStrategy: (s: string) => void; picked: Draft['picked']; setPicked: (p: Draft['picked']) => void; targets: Target[]; insight: Insight | null; options: Opts; preview: Preview | null; busy: boolean; error: string | null;
}) {
  const chosen = targets.filter((t) => t.organizationId in picked);
  // Recommend smart matching when most selected leads match the chosen clients' profiles.
  const recommended = useMemo(() => {
    if (!insight || !insight.eligible) return 'EQUAL';
    let best = 'EQUAL', bestN = 0;
    for (const k of ['GEOGRAPHY', 'INDUSTRY', 'CAMPAIGN', 'SCORE']) {
      const n = insight.clients.filter((c) => c.organizationId in picked).reduce((a, c) => a + (c.matches[k] ?? 0), 0);
      if (n > bestN) { best = k; bestN = n; }
    }
    return bestN >= insight.eligible * 0.6 ? best : 'EQUAL';
  }, [insight, picked]);
  const totalQty = chosen.reduce((a, t) => a + (picked[t.organizationId]?.quantity ?? 0), 0);
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex flex-col gap-4">
        {STRATEGY_GROUPS.map((g) => (
          <div key={g.title}>
            <div className="mb-2 flex items-baseline gap-2"><h3 className="text-[13px] font-medium">{g.title}</h3><span className="text-[11.5px] text-subtle">{g.hint}</span></div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {g.items.map((k) => (
                <button key={k} type="button" onClick={() => setStrategy(k)} aria-pressed={strategy === k}
                  className={cn('relative rounded-lg border bg-surface px-3.5 py-3 text-left transition-all', strategy === k ? 'border-fg shadow-[var(--raised-shadow)] ring-1 ring-fg' : 'border-border hover:border-border-strong')}>
                  {recommended === k && <span className="absolute top-2 right-2"><Badge tone="solid"><Sparkles className="size-3" />Suggested</Badge></span>}
                  <div className="pr-20 text-[12.5px] font-medium">{STRATEGY_INFO[k].label}</div>
                  <div className="mt-0.5 text-[11.5px] leading-snug text-subtle">{STRATEGY_INFO[k].description}</div>
                </button>
              ))}
            </div>
          </div>
        ))}

        {(strategy === 'CUSTOM' || strategy === 'WEIGHTED') && (
          <Card>
            <CardHeader title={strategy === 'CUSTOM' ? 'How many leads per client?' : 'Relative weight per client'} description={strategy === 'CUSTOM' ? `${fmtInt(totalQty)} requested of ${fmtInt(insight?.eligible ?? 0)} available` : 'A client with weight 2 receives about twice as many as weight 1.'}
              actions={strategy === 'CUSTOM' && insight ? <Button size="xs" variant="ghost" onClick={() => { const each = Math.floor(insight.eligible / Math.max(1, chosen.length)); setPicked(Object.fromEntries(chosen.map((t) => [t.organizationId, { ...picked[t.organizationId], quantity: each }]))); }}>Split evenly</Button> : null} />
            <div className="divide-y divide-border">
              {chosen.map((t) => (
                <div key={t.organizationId} className="flex items-center gap-3 px-4 py-2">
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{t.name}<span className="text-subtle"> · {t.capacity == null ? 'no limit' : `${fmtInt(t.capacity)} room`}</span></span>
                  <Input type="number" min={0} className="h-8 w-28" aria-label={`${strategy === 'CUSTOM' ? 'Quantity' : 'Weight'} for ${t.name}`}
                    value={strategy === 'CUSTOM' ? (picked[t.organizationId]?.quantity ?? '') : (picked[t.organizationId]?.weight ?? t.weight)}
                    onChange={(e) => setPicked({ ...picked, [t.organizationId]: { ...picked[t.organizationId], [strategy === 'CUSTOM' ? 'quantity' : 'weight']: Math.max(0, Number(e.target.value)) } })} />
                </div>
              ))}
            </div>
          </Card>
        )}

        <Card>
          <CardHeader title="Options" />
          <CardBody className="grid grid-cols-1 gap-3 text-[12.5px] md:grid-cols-2">
            <OptionRow title="Don't resend to previous clients" hint="Leads never go back to a client that already had them." checked={o.avoidPrevious} onChange={o.setAvoidPrevious} />
            <OptionRow title="Respect client quotas" hint="Stop at each client's active, daily and monthly limits." checked={o.respectQuotas} onChange={o.setRespectQuotas} />
            <OptionRow title="Include leads with invalid contact data" hint="Off by default — clients rarely want these." checked={o.includeInvalid} onChange={o.setIncludeInvalid} />
            <OptionRow title="Schedule for later" hint="Leads are reserved now and sent at the chosen time." checked={o.schedule} onChange={o.setSchedule} />
            {o.schedule && <Input type="datetime-local" value={o.scheduledFor} min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)} onChange={(e) => o.setScheduledFor(e.target.value)} aria-label="Scheduled time" />}
            {!o.respectQuotas && <InlineNotice tone="warn" className="md:col-span-2">Quotas will be ignored. Use only for authorized exceptions — this is recorded on the batch.</InlineNotice>}
            <Field label="Note (optional)" className="md:col-span-2"><Textarea value={o.note} onChange={(e) => o.setNote(e.target.value)} placeholder="Why this distribution? Visible in the batch and audit log." maxLength={500} rows={2} /></Field>
          </CardBody>
        </Card>
      </div>
      <div className="xl:sticky xl:top-20 xl:self-start">
        <LivePlan preview={preview} busy={busy} error={error} />
      </div>
    </div>
  );
}

function OptionRow({ title, hint, checked, onChange }: { title: string; hint: string; checked: boolean; onChange: (b: boolean) => void }) {
  return (
    <label className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5">
      <span><span className="block font-medium">{title}</span><span className="block text-[11.5px] text-subtle">{hint}</span></span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} />
    </label>
  );
}

function LivePlan({ preview, busy, error }: { preview: Preview | null; busy: boolean; error: string | null }) {
  const max = Math.max(1, ...(preview?.targets.map((t) => t.planned) ?? [1]));
  return (
    <Card>
      <CardHeader title="Live plan" description="Updates as you change options — nothing is sent yet" actions={busy ? <Loader2 className="size-3.5 animate-spin text-subtle" /> : null} />
      <CardBody className="flex flex-col gap-3">
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
        {!preview ? <Skeleton className="h-40" /> : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Tile label="Selected" value={preview.selected} />
              <Tile label="Eligible" value={preview.eligible} />
              <Tile label="Will be sent" value={preview.planned} strong />
            </div>
            <div className="flex flex-col gap-2">
              {preview.targets.map((t) => (
                <div key={t.organizationId}>
                  <div className="flex items-center justify-between gap-2 text-[12px]"><span className="truncate">{t.name}</span><span className="tnum shrink-0">{t.eligible ? <>{fmtInt(t.planned)}{t.requested != null && <span className="text-subtle"> / {fmtInt(t.requested)}</span>}</> : <Badge tone="warn">{t.reason}</Badge>}</span></div>
                  <div className="mt-1 h-1.5 rounded-full bg-surface-3"><div className="h-full rounded-full bg-fg transition-all duration-300" style={{ width: `${(t.planned / max) * 100}%` }} /></div>
                </div>
              ))}
            </div>
            <NotSent preview={preview} />
          </>
        )}
      </CardBody>
    </Card>
  );
}

function NotSent({ preview }: { preview: Preview }) {
  const rows = [...Object.entries(preview.skipped), ...Object.entries(preview.unassigned)];
  if (!rows.length) return null;
  return (
    <div className="rounded-md border border-border px-3 py-2 text-[11.5px] text-muted">
      <div className="mb-1 flex items-center gap-1 text-subtle"><Filter className="size-3" /> Not sent</div>
      {rows.map(([r, n]) => <div key={r} className="flex justify-between gap-2"><span>{r}</span><span className="tnum">{fmtInt(n)}</span></div>)}
    </div>
  );
}

// ── Step 4: review ───────────────────────────────────────────────────

function StepReview({ preview, busy, error, count, strategy, schedule, avoidPrevious, respectQuotas }: { preview: Preview | null; busy: boolean; error: string | null; count: number; strategy: string; schedule: string | null; avoidPrevious: boolean; respectQuotas: boolean }) {
  if (error) return <InlineNotice tone="danger">{error}</InlineNotice>;
  if (!preview || busy) return <div className="grid grid-cols-1 gap-3 md:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40" />)}</div>;
  const sent = preview.targets.filter((t) => t.planned > 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Leads selected" value={count} />
        <Tile label="Will be sent" value={preview.planned} strong />
        <Tile label="Clients receiving" value={sent.length} />
        <Tile label="Going to a new client after a previous one" value={preview.redistributed} />
      </div>
      <div className="flex flex-wrap gap-2 text-[11.5px]">
        <Badge tone="outline">{STRATEGY_INFO[strategy]?.label}</Badge>
        {avoidPrevious && <Badge tone="outline">No resends to previous clients</Badge>}
        <Badge tone={respectQuotas ? 'outline' : 'warn'}>{respectQuotas ? 'Quotas respected' : 'Quotas ignored'}</Badge>
        {schedule ? <Badge tone="outline"><CalendarClock className="size-3" />Scheduled {schedule.replace('T', ' ')}</Badge> : <Badge tone="outline">Sends immediately</Badge>}
        {preview.largeBatch && <Badge tone="warn">Large batch — typed confirmation required</Badge>}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {preview.targets.map((t) => (
          <Card key={t.organizationId} className={cn(!t.planned && 'opacity-60')}>
            <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
              <div className="min-w-0"><div className="truncate text-[13px] font-medium">{t.name}</div><div className="text-[11px] text-subtle">{t.capacity == null ? 'No quota limit' : `${fmtInt(t.capacity)} room before this batch`}</div></div>
              <div className="text-right"><div className="tnum text-[20px] font-semibold tracking-[-0.02em]">{fmtInt(t.planned)}</div><div className="text-[10.5px] text-subtle">{preview.planned ? fmtPct(t.planned / preview.planned, 0) : '—'} of batch</div></div>
            </div>
            <div className="px-4 py-2.5">
              {!t.eligible ? <Badge tone="warn">{t.reason}</Badge> : !t.sample.length ? <span className="text-[11.5px] text-subtle">No leads for this client with the current settings.</span> : (
                <ul className="flex flex-col gap-1">
                  {t.sample.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-2 text-[11.5px]"><span className="truncate"><span className="text-fg">{l.fullName}</span><span className="text-subtle"> · {[l.country, l.industry].filter(Boolean).join(' · ') || l.company || '—'}</span></span>{l.distributionCount > 0 && <Badge tone="dim">{l.distributionCount}× before</Badge>}</li>
                  ))}
                  {t.planned > t.sample.length && <li className="text-[11px] text-subtle">+ {fmtInt(t.planned - t.sample.length)} more</li>}
                </ul>
              )}
            </div>
          </Card>
        ))}
      </div>
      <NotSent preview={preview} />
    </div>
  );
}
