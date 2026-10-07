'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRight, Globe, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { DataTable } from '@/components/data/data-table';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Drawer, Tooltip } from '@/components/ui/overlay';
import { cn } from '@/lib/cn';
import type { Condition } from '@/lib/filters';
import { fmtAgo, fmtDateTime, fmtInt, humanize } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { MultiFilter, TimesFilter, type Facets } from '@/components/data/quick-filters';

type Assignment = {
  id: string; status: string; assignedAt: string; endedAt: string | null; endedReason: string | null;
  organization: { id: string; name: string; industry: string | null; domain: string | null };
  batch: { id: string; code: string; strategy: string } | null;
  clientLead: { status: string; firstContactAt: string | null } | null;
};
type Row = { id: string; fullName: string; company: string | null; email: string | null; country: string | null; industry: string | null; source: string | null; score: number; allocationStatus: string; clientStatus: string | null; distributionCount: number; lastDistributedAt: string | null; clients: number; assignments: Assignment[] };

const ENDED: Record<string, string> = { REVOKED: 'Returned', REASSIGNED: 'Moved on', ROLLED_BACK: 'Rolled back' };

export function DistributionTracker() {
  const facets = useApiQuery<Facets>('/api/v1/leads/facets');
  const [q, setQ] = useState('');
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ id: string; desc: boolean } | null>(null);
  const [open, setOpen] = useState<Row | null>(null);
  const filter = useMemo(() => JSON.stringify({ q: q.trim() || undefined, conditions }), [q, conditions]);
  const { data, isFetching } = useApiQuery<{ total: number; rows: Row[] }>(`/api/v1/distribution/tracker?page=${page}&pageSize=25&filter=${encodeURIComponent(filter)}${sort ? `&sort=${encodeURIComponent(JSON.stringify(sort))}` : ''}`);
  const orgs = (facets.data?.orgs ?? []).map((o) => ({ value: o.id, label: o.name }));
  const opt = (xs: string[]) => xs.map((v) => ({ value: v, label: v }));
  const set = (c: Condition[]) => { setConditions(c); setPage(1); };

  const columns: ColumnDef<Row, unknown>[] = [
    { id: 'fullName', header: 'Lead', enableSorting: true, cell: ({ row: { original: r } }) => <div className="min-w-[160px]"><div className="text-fg">{r.fullName}</div><div className="truncate text-[11px] text-subtle">{r.company ?? '—'} · {[r.country, r.industry].filter(Boolean).join(' · ') || '—'}</div></div> },
    { id: 'distributionCount', header: 'Times', enableSorting: true, cell: ({ row: { original: r } }) => <div><div className="tnum text-[13px] font-semibold">{r.distributionCount}×</div><div className="text-[10.5px] text-subtle">{r.clients} client{r.clients === 1 ? '' : 's'}</div></div> },
    {
      id: 'journey', header: 'Journey (oldest → newest)',
      cell: ({ row: { original: r } }) => (
        <div className="flex max-w-[520px] flex-wrap items-center gap-1">
          {r.assignments.map((a, i) => (
            <span key={a.id} className="flex items-center gap-1">
              {i > 0 && <ArrowRight className="size-3 text-faint" />}
              <Tooltip content={<span>{a.organization.name}{a.organization.domain ? ` (${a.organization.domain})` : ''} · {fmtDateTime(a.assignedAt)}{a.endedAt ? ` → ${ENDED[a.status] ?? humanize(a.status)} ${fmtDateTime(a.endedAt)}` : ' · current'}</span>}>
                <span className={cn('inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11.5px]', a.status === 'ACTIVE' ? 'border-fg bg-fg text-inverse' : 'border-dashed border-border-strong text-muted')}>
                  <span className="max-w-[130px] truncate">{a.organization.name}</span>
                  {a.status !== 'ACTIVE' && <span className="text-[10px] text-subtle">{ENDED[a.status] ?? humanize(a.status)}</span>}
                </span>
              </Tooltip>
            </span>
          ))}
        </div>
      ),
    },
    { id: 'current', header: 'Now', cell: ({ row: { original: r } }) => (r.allocationStatus === 'ALLOCATED' ? <div className="flex flex-col gap-0.5"><StatusBadge status={r.clientStatus ?? 'NEW'} /></div> : <StatusBadge status={r.allocationStatus} />) },
    { id: 'lastDistributedAt', header: 'Last sent', enableSorting: true, cell: ({ row: { original: r } }) => <span className="text-subtle">{fmtAgo(r.lastDistributedAt)}</span> },
  ];

  return (
    <>
      <DataTable
        columns={columns} data={data?.rows ?? []} total={data?.total ?? 0} page={page} pageSize={25} onPage={setPage} loading={isFetching}
        sort={sort} onSort={setSort} getRowId={(r) => r.id} onRowClick={setOpen}
        empty={<div className="py-10 text-center text-[12.5px] text-subtle">No distributed leads match these filters.</div>}
        toolbar={
          <div className="flex w-full flex-wrap items-center gap-2">
            <div className="relative w-full max-w-[240px]"><Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search leads" className="h-7 pl-8 text-[12px]" /></div>
            <MultiFilter label="Sent to client" field="everClient" options={orgs} conditions={conditions} onChange={set} negatable />
            <MultiFilter label="Currently with" field="assignedOrganizationId" options={orgs} conditions={conditions} onChange={set} />
            <MultiFilter label="Country" field="country" options={opt(facets.data?.countries ?? [])} conditions={conditions} onChange={set} />
            <MultiFilter label="Source" field="source" options={opt(facets.data?.sources ?? [])} conditions={conditions} onChange={set} />
            <MultiFilter label="Client status" field="clientStatus" options={opt(['NEW', 'CONTACTED', 'QUALIFIED', 'NEGOTIATION', 'CONVERTED', 'LOST']).map((o) => ({ ...o, label: humanize(o.value) }))} conditions={conditions} onChange={set} />
            <TimesFilter conditions={conditions} onChange={set} />
            {(conditions.length > 0 || q) && <button type="button" onClick={() => { set([]); setQ(''); }} className="flex items-center gap-1 text-[12px] text-subtle hover:text-fg"><X className="size-3" />Clear</button>}
            <span className="ml-auto text-[12px] text-subtle"><b className="tnum font-medium text-fg">{fmtInt(data?.total ?? 0)}</b> distributed leads</span>
          </div>
        }
      />
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open?.fullName ?? ''} description={open ? `Distributed ${open.distributionCount} time${open.distributionCount === 1 ? '' : 's'} to ${open.clients} client${open.clients === 1 ? '' : 's'}` : ''} width="md">
        {open && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-1.5 text-[11.5px]">
              {open.company && <Badge tone="outline">{open.company}</Badge>}
              {open.country && <Badge tone="outline">{open.country}</Badge>}
              {open.industry && <Badge tone="outline">{open.industry}</Badge>}
              {open.source && <Badge tone="outline">{open.source}</Badge>}
              <Badge tone="outline">Score {open.score}</Badge>
              <Link href={`/admin/leads/${open.id}`} className="ml-auto text-[12px] text-muted underline underline-offset-2 hover:text-fg">Open lead</Link>
            </div>
            <ol className="relative ml-2 border-l border-border-strong">
              {[...open.assignments].reverse().map((a) => (
                <li key={a.id} className="relative mb-4 pl-5 last:mb-0">
                  <span className={cn('absolute top-1 -left-[6px] size-[11px] rounded-full border-2', a.status === 'ACTIVE' ? 'border-fg bg-fg' : 'border-border-strong bg-surface')} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/organizations/${a.organization.id}`} className="text-[13px] font-medium hover:underline">{a.organization.name}</Link>
                    {a.status === 'ACTIVE' ? <Badge tone="solid">Current</Badge> : <Badge tone="dim">{ENDED[a.status] ?? humanize(a.status)}</Badge>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-subtle">
                    {a.organization.domain && <span className="flex items-center gap-1"><Globe className="size-3" />{a.organization.domain}</span>}
                    {a.organization.industry && <span>{a.organization.industry}</span>}
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px]">
                    <span className="text-subtle">Sent</span><span>{fmtDateTime(a.assignedAt)}</span>
                    {a.batch && <><span className="text-subtle">Batch</span><Link href={`/admin/distribution/batches/${a.batch.id}`} className="font-mono hover:underline">{a.batch.code}</Link></>}
                    {a.clientLead && <><span className="text-subtle">Client progress</span><span><StatusBadge status={a.clientLead.status} /></span></>}
                    <span className="text-subtle">First contact</span><span>{a.clientLead?.firstContactAt ? fmtDateTime(a.clientLead.firstContactAt) : '—'}</span>
                    {a.endedAt && <><span className="text-subtle">Ended</span><span>{fmtDateTime(a.endedAt)}{a.endedReason ? ` — ${a.endedReason}` : ''}</span></>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </Drawer>
    </>
  );
}
