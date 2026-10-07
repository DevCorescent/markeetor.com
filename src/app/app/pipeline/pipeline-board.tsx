'use client';
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import { Clock, LayoutGrid, Rows3, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Select } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtDate, fmtInt, fmtMoney } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';

type Deal = { id: string; fullName: string; company: string | null; dealValue: number | null; currency: string; priority: string; stageEnteredAt: string | null; expectedCloseDate: string | null; probability: number | null; owner: { name: string } | null };
type Stage = { id: string; name: string; category: string; probability: number; stagnantAfterDays: number | null; requiresApproval: boolean; count: number; value: number; leads: Deal[] };
const LOST_REASONS = ['No budget', 'Chose a competitor', 'Not interested', 'Unresponsive', 'Bad timing', 'Not a fit'];

export function PipelineBoard({ canMove, all, canManage }: { canMove: boolean; all: boolean; canManage: boolean }) {
  const [view, setView] = useState<'board' | 'table'>('board');
  const [owner, setOwner] = useState('');
  const url = `/api/v1/crm/pipeline?perStage=50${owner ? `&ownerId=${owner}` : ''}`;
  const { data, error, isLoading } = useApiQuery<{ stages: Stage[] }>(url);
  const members = useApiQuery<{ members: { id: string; name: string }[] }>(all ? '/api/v1/crm/leads/facets' : null);
  const qc = useQueryClient();
  const [active, setActive] = useState<Deal | null>(null);
  const [lost, setLost] = useState<{ deal: Deal; stageId: string } | null>(null);
  const [reason, setReason] = useState(LOST_REASONS[0]);
  // Touch: press and hold to pick a card up, so a swipe still scrolls the board.
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }), useSensor(KeyboardSensor));

  const move = async (deal: Deal, stageId: string, lostReason?: string) => {
    const prev = qc.getQueryData<{ stages: Stage[] }>([url]);
    // Optimistic move; rolled back if the server rejects it.
    qc.setQueryData<{ stages: Stage[] }>([url], (d) => d && {
      stages: d.stages.map((s) => ({
        ...s,
        leads: s.id === stageId ? [deal, ...s.leads.filter((l) => l.id !== deal.id)] : s.leads.filter((l) => l.id !== deal.id),
        count: s.count + (s.id === stageId ? 1 : s.leads.some((l) => l.id === deal.id) ? -1 : 0),
      })),
    });
    try {
      await api(`/api/v1/crm/leads/${deal.id}/stage`, { body: { stageId, lostReason } });
      toast.success(`Moved ${deal.fullName}`);
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/api/v1/crm') });
    } catch (e) {
      qc.setQueryData([url], prev);
      toast.error(errorMessage(e));
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActive(null);
    const deal = e.active.data.current?.deal as Deal | undefined;
    const target = data?.stages.find((s) => s.id === e.over?.id);
    if (!deal || !target || target.leads.some((l) => l.id === deal.id)) return;
    if (target.category === 'LOST') setLost({ deal, stageId: target.id });
    else move(deal, target.id);
  };

  const openValue = data?.stages.filter((s) => s.category === 'OPEN').reduce((a, s) => a + s.value, 0) ?? 0;
  const weighted = data?.stages.filter((s) => s.category === 'OPEN').reduce((a, s) => a + (s.value * s.probability) / 100, 0) ?? 0;

  return (
    <>
      <PageHeader title="Pipeline" description={`${fmtMoney(openValue)} open · ${fmtMoney(weighted)} weighted by stage probability`}
        actions={
          <>
            {all && <Select className="h-8 w-44" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner"><option value="">All owners</option>{members.data?.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}
            <div className="flex items-center rounded-md border border-border bg-surface p-0.5">
              <button aria-label="Board view" aria-pressed={view === 'board'} onClick={() => setView('board')} className={`grid h-7 w-8 place-items-center rounded ${view === 'board' ? 'bg-fg text-inverse' : 'text-muted'}`}><LayoutGrid className="size-3.5" /></button>
              <button aria-label="Table view" aria-pressed={view === 'table'} onClick={() => setView('table')} className={`grid h-7 w-8 place-items-center rounded ${view === 'table' ? 'bg-fg text-inverse' : 'text-muted'}`}><Rows3 className="size-3.5" /></button>
            </div>
            {canManage && <Link href="/app/settings?tab=pipeline"><Button variant="ghost"><Settings2 /> Stages</Button></Link>}
          </>
        } />
      {error ? <ErrorState description={errorMessage(error)} /> : isLoading || !data ? <Skeleton className="h-[480px]" /> : view === 'table' ? (
        <Card>
          <SimpleTable rows={data.stages.flatMap((s) => s.leads.map((l) => ({ ...l, stage: s.name, stageCat: s.category, stagnant: s.stagnantAfterDays })))} columns={[
            { key: 'fullName', header: 'Deal', render: (r) => <Link className="text-fg hover:underline" href={`/app/leads/${r.id}`}>{r.fullName}<span className="text-subtle"> · {r.company ?? '—'}</span></Link> },
            { key: 'stage', header: 'Stage' }, { key: 'owner', header: 'Owner', render: (r) => r.owner?.name ?? '—' },
            { key: 'dealValue', header: 'Value', className: 'tnum text-right', render: (r) => (r.dealValue ? fmtMoney(r.dealValue, r.currency) : '—') },
            { key: 'probability', header: 'Prob.', className: 'tnum text-right', render: (r) => (r.probability != null ? `${r.probability}%` : '—') },
            { key: 'expectedCloseDate', header: 'Close', render: (r) => fmtDate(r.expectedCloseDate) },
            { key: 'stageEnteredAt', header: 'In stage', render: (r) => <span className={r.stagnant && r.stageEnteredAt && Date.now() - new Date(r.stageEnteredAt).getTime() > r.stagnant * 86400_000 ? 'text-warn' : 'text-subtle'}>{r.stageEnteredAt ? fmtAgo(r.stageEnteredAt).replace(' ago', '') : '—'}</span> },
          ]} />
        </Card>
      ) : (
        <DndContext sensors={sensors} onDragStart={(e) => setActive(e.active.data.current?.deal ?? null)} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
          <div className="-mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-4 scroll-px-3 sm:-mx-4 sm:snap-none sm:px-4 md:-mx-6 md:px-6">
            {data.stages.map((s) => <Column key={s.id} stage={s} canMove={canMove} />)}
          </div>
          <DragOverlay>{active ? <DealCard deal={active} stagnantDays={null} dragging /> : null}</DragOverlay>
        </DndContext>
      )}
      <ConfirmDialog open={!!lost} onOpenChange={(o) => !o && setLost(null)} title={`Mark ${lost?.deal.fullName} as lost`} danger confirmLabel="Mark lost" onConfirm={() => move(lost!.deal, lost!.stageId, reason)}>
        <Field label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value)}>{LOST_REASONS.map((r) => <option key={r}>{r}</option>)}</Select></Field>
      </ConfirmDialog>
    </>
  );
}

function Column({ stage, canMove }: { stage: Stage; canMove: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, disabled: !canMove });
  return (
    <section ref={setNodeRef} aria-label={stage.name} className={cn('flex w-[85vw] max-w-[320px] shrink-0 snap-start flex-col rounded-lg border bg-surface transition-colors sm:w-[272px]', isOver ? 'border-fg/50 bg-surface-2' : 'border-border')}>
      <header className="flex items-start justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12.5px] font-medium">{stage.name}{stage.category !== 'OPEN' && <StatusBadge status={stage.category} />}</div>
          <div className="tnum text-[11px] text-subtle">{fmtInt(stage.count)} · {fmtMoney(stage.value)}{stage.category === 'OPEN' ? ` · ${stage.probability}%` : ''}</div>
        </div>
        {stage.requiresApproval && <span className="text-[10px] text-warn">approval</span>}
      </header>
      <div className="flex max-h-[calc(100vh-260px)] min-h-[120px] flex-col gap-2 overflow-y-auto p-2">
        {stage.leads.map((d) => <Draggable key={d.id} deal={d} disabled={!canMove} stagnantDays={stage.stagnantAfterDays} />)}
        {stage.count > stage.leads.length && <p className="px-1 py-1 text-center text-[11px] text-subtle">+{fmtInt(stage.count - stage.leads.length)} more — use table view or filters</p>}
        {stage.leads.length === 0 && <p className="px-1 py-6 text-center text-[11px] text-faint">Drop deals here</p>}
      </div>
    </section>
  );
}

function Draggable({ deal, disabled, stagnantDays }: { deal: Deal; disabled: boolean; stagnantDays: number | null }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: deal.id, data: { deal }, disabled });
  return <div ref={setNodeRef} {...listeners} {...attributes} className={cn(isDragging && 'opacity-30')}><DealCard deal={deal} stagnantDays={stagnantDays} /></div>;
}

function DealCard({ deal, stagnantDays, dragging }: { deal: Deal; stagnantDays: number | null; dragging?: boolean }) {
  const stagnant = stagnantDays != null && deal.stageEnteredAt && Date.now() - new Date(deal.stageEnteredAt).getTime() > stagnantDays * 86400_000;
  return (
    <div className={cn('rounded-md border bg-surface-2 px-3 py-2.5 text-left', dragging ? 'cursor-grabbing border-fg/60 shadow-2xl' : 'cursor-grab border-border-strong hover:border-faint')}>
      <Link href={`/app/leads/${deal.id}`} className="block truncate text-[12.5px] text-fg hover:underline" onPointerDown={(e) => e.stopPropagation()}>{deal.fullName}</Link>
      <div className="truncate text-[11px] text-subtle">{deal.company ?? '—'}</div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
        <span className="tnum text-fg-2">{deal.dealValue ? fmtMoney(deal.dealValue, deal.currency) : '—'}</span>
        <span className={cn('flex items-center gap-1', stagnant ? 'text-warn' : 'text-subtle')} title={stagnant ? 'Stagnant: exceeded the stage’s expected duration' : undefined}><Clock className="size-3" />{deal.stageEnteredAt ? fmtAgo(deal.stageEnteredAt).replace(' ago', '') : '—'}</span>
      </div>
      {deal.owner && <div className="mt-1 truncate text-[10.5px] text-subtle">{deal.owner.name}</div>}
    </div>
  );
}
