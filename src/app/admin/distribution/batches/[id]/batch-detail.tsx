'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { Loader2, RotateCcw, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { BarList } from '@/components/data/charts';
import { DataTable } from '@/components/data/data-table';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, DefinitionList } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Select } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/overlay';
import { Kpi, PageHeader } from '@/components/ui/page';
import { ErrorState, InlineNotice, Skeleton } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { api, errorMessage } from '@/lib/api-client';
import { fmtDateTime, fmtInt, humanize } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { STRATEGY_INFO } from '../../strategies';

type Detail = {
  batch: { id: string; code: string; mode: string; strategy: string; status: string; selection: { mode: string; ids?: string[]; filter?: { conditions: unknown[] } }; rules: { respectQuotas?: boolean; ineligibleTargets?: { organizationId: string; reason: string }[] }; selectedCount: number; allocatedCount: number; failedCount: number; skippedCount: number; pendingCount: number; note: string | null; createdAt: string; scheduledFor: string | null; startedAt: string | null; completedAt: string | null; rolledBackAt: string | null; rollbackReason: string | null; rollbackCount: number; idempotencyKey: string; ruleId: string | null };
  byOrg: ({ organizationId: string; name: string; code: string } & Record<string, number | string>)[];
  reasons: { reason: string; count: number }[];
  initiator: { name: string; email: string } | null;
  rolledBackBy: { name: string } | null;
};
type Item = { id: string; status: string; reason: string | null; organization: string | null; processedAt: string | null; lead: { id: string; fullName: string; company: string | null } };

export function BatchDetail({ id, canRollback, canForce, canCancel }: { id: string; canRollback: boolean; canForce: boolean; canCancel: boolean }) {
  const { data, error, isLoading } = useApiQuery<Detail>(`/api/v1/distribution/batches/${id}`, { refetchInterval: 3000 });
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const items = useApiQuery<{ total: number; rows: Item[] }>(`/api/v1/distribution/batches/${id}/items?page=${page}&pageSize=25${status ? `&status=${status}` : ''}`);
  const [dlg, setDlg] = useState<null | 'rollback' | 'cancel'>(null);
  const [force, setForce] = useState(false);
  const rollback = useApiMutation((reason: string) => api<{ revoked: number; keptWorked: number }>(`/api/v1/distribution/batches/${id}/rollback`, { body: { reason, force } }), {
    success: (r) => `${r.revoked} allocation(s) rolled back${r.keptWorked ? ` · ${r.keptWorked} kept (client already working them)` : ''}`, invalidate: ['/api/v1/distribution'],
  });
  const cancel = useApiMutation((reason: string) => api<{ released: number }>(`/api/v1/distribution/batches/${id}/cancel`, { body: { reason } }), { success: (r) => `Cancelled · ${r.released} leads released`, invalidate: ['/api/v1/distribution'] });

  if (error) return <ErrorState description={errorMessage(error)} />;
  if (isLoading || !data) return <Skeleton className="h-96" />;
  const b = data.batch;
  const running = ['QUEUED', 'PROCESSING'].includes(b.status);
  const total = b.allocatedCount + b.failedCount + b.pendingCount;
  const cols: ColumnDef<Item, unknown>[] = [
    { id: 'lead', header: 'Lead', cell: ({ row: { original: r } }) => <Link className="hover:underline" href={`/admin/leads/${r.lead.id}`}>{r.lead.fullName}<span className="text-subtle"> · {r.lead.company ?? '—'}</span></Link> },
    { id: 'org', header: 'Organization', cell: ({ row: { original: r } }) => r.organization ?? <span className="text-subtle">—</span> },
    { id: 'status', header: 'Outcome', cell: ({ row: { original: r } }) => <StatusBadge status={r.status} /> },
    { id: 'reason', header: 'Reason', cell: ({ row: { original: r } }) => <span className="text-muted">{r.reason ?? '—'}</span> },
    { id: 'at', header: 'Processed', cell: ({ row: { original: r } }) => <span className="text-subtle">{fmtDateTime(r.processedAt)}</span> },
  ];

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Distribution', href: '/admin/distribution?tab=batches' }, { label: b.code }]}
        title={<span className="flex items-center gap-3 font-mono">{b.code}<StatusBadge status={b.status} /></span>}
        description={`${STRATEGY_INFO[b.strategy]?.label ?? b.strategy} · ${humanize(b.mode)} · initiated by ${data.initiator?.name ?? 'automation'} ${fmtDateTime(b.createdAt)}`}
        actions={
          <>
            {canCancel && ['SCHEDULED', 'QUEUED'].includes(b.status) && <Button variant="ghost" onClick={() => setDlg('cancel')}><X /> Cancel batch</Button>}
            {canRollback && ['COMPLETED', 'PARTIAL'].includes(b.status) && <Button variant="danger" onClick={() => setDlg('rollback')}><RotateCcw /> Roll back</Button>}
          </>
        }
      />
      {running && (
        <Card className="mb-4"><CardBody className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[12.5px]"><Loader2 className="size-4 animate-spin" /> {b.status === 'QUEUED' ? 'Queued — waiting for the worker' : 'Allocating…'} {fmtInt(b.allocatedCount + b.failedCount)} / {fmtInt(total)}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-fg transition-all" style={{ width: `${total ? ((b.allocatedCount + b.failedCount) / total) * 100 : 0}%` }} /></div>
        </CardBody></Card>
      )}
      {b.status === 'SCHEDULED' && <InlineNotice className="mb-4">Scheduled for {fmtDateTime(b.scheduledFor)}. {fmtInt(b.pendingCount)} leads are reserved for this batch until it runs or is cancelled.</InlineNotice>}
      <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-5">
        <Kpi label="Selected" value={fmtInt(b.selectedCount)} />
        <Kpi label="Allocated" value={fmtInt(b.allocatedCount)} />
        <Kpi label="Failed" value={fmtInt(b.failedCount)} />
        <Kpi label="Skipped" value={fmtInt(b.skippedCount)} />
        <Kpi label="Pending" value={fmtInt(b.pendingCount)} />
      </div>
      <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="By organization" />
          <SimpleTable rows={data.byOrg} columns={[
            { key: 'name', header: 'Organization', render: (r) => <Link className="hover:underline" href={`/admin/organizations/${r.organizationId}`}>{r.name}</Link> },
            { key: 'ASSIGNED', header: 'Assigned', className: 'tnum text-right', render: (r) => fmtInt(Number(r.ASSIGNED ?? 0)) },
            { key: 'FAILED', header: 'Failed', className: 'tnum text-right', render: (r) => fmtInt(Number(r.FAILED ?? 0)) },
            { key: 'PENDING', header: 'Pending', className: 'tnum text-right', render: (r) => fmtInt(Number(r.PENDING ?? 0)) },
            { key: 'ROLLED_BACK', header: 'Rolled back', className: 'tnum text-right', render: (r) => fmtInt(Number(r.ROLLED_BACK ?? 0)) },
          ]} />
        </Card>
        <Card>
          <CardHeader title="Not allocated — reasons" />
          <CardBody><BarList items={data.reasons.map((r) => ({ label: r.reason, value: r.count }))} empty="Every planned lead was allocated" /></CardBody>
        </Card>
      </div>
      <Card className="mb-4">
        <CardHeader title="Batch record" />
        <CardBody>
          <DefinitionList items={[
            ['Selection', b.selection.mode === 'ids' ? `${fmtInt(b.selection.ids?.length ?? 0)} explicit leads` : `Filter with ${b.selection.filter?.conditions.length ?? 0} condition(s)`],
            ['Quotas', b.rules.respectQuotas === false ? 'Ignored (exception)' : 'Enforced'],
            ['Ineligible targets', b.rules.ineligibleTargets?.length ? b.rules.ineligibleTargets.map((t) => t.reason).join('; ') : 'None'],
            ['Note', b.note], ['Idempotency key', <span key="k" className="font-mono text-[11px]">{b.idempotencyKey}</span>],
            ['Started', fmtDateTime(b.startedAt)], ['Completed', fmtDateTime(b.completedAt)],
            ['Rolled back', b.rolledBackAt ? `${fmtDateTime(b.rolledBackAt)} by ${data.rolledBackBy?.name ?? '—'} (${b.rollbackCount}) — ${b.rollbackReason}` : '—'],
          ]} />
        </CardBody>
      </Card>
      <DataTable columns={cols} data={items.data?.rows ?? []} total={items.data?.total ?? 0} page={page} pageSize={25} onPage={setPage} loading={items.isFetching} getRowId={(r) => r.id} dense
        toolbar={<Select className="h-7 w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Outcome"><option value="">All outcomes</option>{['PENDING', 'ASSIGNED', 'SKIPPED', 'FAILED', 'ROLLED_BACK'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>} />
      <ConfirmDialog open={dlg === 'rollback'} onOpenChange={(o) => !o && setDlg(null)} title={`Roll back ${b.code}`} danger requireReason confirmLabel="Roll back" typed={b.allocatedCount >= 100 ? 'ROLLBACK' : undefined}
        description="Allocations are revoked and leads return to the pool. Leads the client has already worked (contacted, progressed, or annotated) are kept unless you force it." onConfirm={(r) => rollback.mutateAsync(r)}>
        {canForce && <label className="flex items-center gap-2 text-[12.5px]"><Checkbox checked={force} onCheckedChange={setForce} aria-label="Force" /> Also revoke leads the client has already worked</label>}
      </ConfirmDialog>
      <ConfirmDialog open={dlg === 'cancel'} onOpenChange={(o) => !o && setDlg(null)} title={`Cancel ${b.code}`} requireReason confirmLabel="Cancel batch" description="Reserved leads are released back to the pool." onConfirm={(r) => cancel.mutateAsync(r)} />
    </>
  );
}
