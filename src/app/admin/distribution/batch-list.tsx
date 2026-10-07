'use client';
import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DataTable } from '@/components/data/data-table';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Select } from '@/components/ui/input';
import { errorMessage } from '@/lib/api-client';
import { fmtAgo, fmtDateTime, fmtInt, humanize } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { STRATEGY_INFO } from './strategies';

type Batch = { id: string; code: string; mode: string; strategy: string; status: string; selectedCount: number; allocatedCount: number; failedCount: number; skippedCount: number; pendingCount: number; initiatedBy: string; createdAt: string; scheduledFor: string | null; note: string | null; rollbackCount: number };

const columns: ColumnDef<Batch, unknown>[] = [
  { id: 'code', header: 'Batch', cell: ({ row: { original: b } }) => <div><div className="font-mono text-[12px] text-fg">{b.code}</div><div className="max-w-[220px] truncate text-[11px] text-subtle">{b.note ?? humanize(b.mode)}</div></div> },
  { id: 'strategy', header: 'Strategy', cell: ({ row: { original: b } }) => <span className="text-muted">{STRATEGY_INFO[b.strategy]?.label ?? b.strategy}{b.mode !== 'MANUAL' && <Badge tone="outline" className="ml-1.5">{humanize(b.mode)}</Badge>}</span> },
  { id: 'status', header: 'Status', cell: ({ row: { original: b } }) => <span className="flex items-center gap-1.5"><StatusBadge status={b.status} />{b.rollbackCount > 0 && b.status !== 'ROLLED_BACK' && <Badge tone="dim">{b.rollbackCount} rolled back</Badge>}</span> },
  { id: 'counts', header: 'Selected → allocated', cell: ({ row: { original: b } }) => <span className="tnum">{fmtInt(b.selectedCount)} → <span className="text-fg">{fmtInt(b.allocatedCount)}</span></span> },
  { id: 'other', header: 'Failed / skipped / pending', cell: ({ row: { original: b } }) => <span className="tnum text-muted"><span className={b.failedCount ? 'text-danger' : ''}>{fmtInt(b.failedCount)}</span> / {fmtInt(b.skippedCount)} / {fmtInt(b.pendingCount)}</span> },
  { id: 'by', header: 'Initiated', cell: ({ row: { original: b } }) => <span className="text-subtle">{b.initiatedBy} · {b.scheduledFor && b.status === 'SCHEDULED' ? `runs ${fmtDateTime(b.scheduledFor)}` : fmtAgo(b.createdAt)}</span> },
];

export function BatchList() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const { data, isFetching, error } = useApiQuery<{ total: number; rows: Batch[] }>(`/api/v1/distribution/batches?page=${page}&pageSize=25${status ? `&status=${status}` : ''}`, { refetchInterval: 8000 });
  return (
    <DataTable
      columns={columns} data={data?.rows ?? []} total={data?.total ?? 0} page={page} pageSize={25} onPage={setPage} loading={isFetching} error={error ? errorMessage(error) : null}
      getRowId={(r) => r.id} onRowClick={(r) => router.push(`/admin/distribution/batches/${r.id}`)}
      toolbar={<Select className="h-7 w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status"><option value="">All statuses</option>{['SCHEDULED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'ROLLED_BACK'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>}
    />
  );
}

type Hist = { id: string; status: string; assignedAt: string; endedAt: string | null; endedReason: string | null; lead: { id: string; fullName: string; company: string | null }; organization: { id: string; name: string }; batch: { id: string; code: string } | null };

export function HistoryList({ organizationId }: { organizationId?: string }) {
  const [page, setPage] = useState(1);
  const { data, isFetching } = useApiQuery<{ total: number; rows: Hist[] }>(`/api/v1/distribution/history?page=${page}&pageSize=25${organizationId ? `&organizationId=${organizationId}` : ''}`);
  const cols: ColumnDef<Hist, unknown>[] = [
    { id: 'lead', header: 'Lead', cell: ({ row: { original: h } }) => <Link className="hover:underline" href={`/admin/leads/${h.lead.id}`}>{h.lead.fullName}<span className="text-subtle"> · {h.lead.company ?? '—'}</span></Link> },
    ...(organizationId ? [] : [{ id: 'org', header: 'Organization', cell: ({ row: { original: h } }: { row: { original: Hist } }) => <Link className="hover:underline" href={`/admin/organizations/${h.organization.id}`}>{h.organization.name}</Link> }]),
    { id: 'status', header: 'Status', cell: ({ row: { original: h } }) => <StatusBadge status={h.status} /> },
    { id: 'batch', header: 'Batch', cell: ({ row: { original: h } }) => (h.batch ? <Link className="font-mono text-[11.5px] hover:underline" href={`/admin/distribution/batches/${h.batch.id}`}>{h.batch.code}</Link> : '—') },
    { id: 'at', header: 'Assigned', cell: ({ row: { original: h } }) => fmtDateTime(h.assignedAt) },
    { id: 'ended', header: 'Ended', cell: ({ row: { original: h } }) => (h.endedAt ? <span title={h.endedReason ?? ''}>{fmtDateTime(h.endedAt)}</span> : <span className="text-subtle">—</span>) },
  ];
  return <DataTable columns={cols} data={data?.rows ?? []} total={data?.total ?? 0} page={page} pageSize={25} onPage={setPage} loading={isFetching} getRowId={(r) => r.id} dense />;
}
