'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { EmptyState, Skeleton } from '@/components/ui/states';
import { Pagination } from '@/components/ui/table-bits';
import { api } from '@/lib/api-client';
import { fmtDate } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';

type Group = { kind: string; key: string; count: number; leads: { id: string; fullName: string; company: string | null; source: string | null; allocationStatus: string; createdAt: string }[] };

export function DuplicateReview() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useApiQuery<{ total: number; groups: Group[] }>(`/api/v1/leads/duplicates?page=${page}&pageSize=10`);
  const [merge, setMerge] = useState<{ primary: string; dups: string[]; label: string } | null>(null);
  const m = useApiMutation((b: { primaryId: string; duplicateIds: string[]; reason: string }) => api('/api/v1/leads/merge', { body: b }), { success: 'Leads merged', invalidate: ['/api/v1/leads'] });

  if (isLoading) return <Skeleton className="h-64 rounded-lg" />;
  if (!data?.groups.length) return <Card><EmptyState title="No duplicate groups" description="No unmerged leads share an email address or phone number." /></Card>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-subtle">Groups of active leads that share a normalized email or phone. Merging keeps the primary (oldest by default), fills its empty fields from the others, and archives the rest with a link back. Allocated leads must be revoked before merging.</p>
      {data.groups.map((g, gi) => (
        <Card key={gi}>
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2 text-[12.5px]"><Badge tone="outline">{g.kind}</Badge><span className="font-mono text-[12px]">{g.key}</span><span className="text-subtle">· {g.count} records</span></div>
            <Button size="sm" disabled={g.leads.some((l) => l.allocationStatus !== 'UNALLOCATED')} onClick={() => setMerge({ primary: g.leads[0].id, dups: g.leads.slice(1).map((l) => l.id), label: g.leads[0].fullName })}>Merge into oldest</Button>
          </div>
          <ul>
            {g.leads.map((l, i) => (
              <li key={l.id} className="flex items-center gap-3 border-b border-border/60 px-4 py-2 text-[12.5px] last:border-0">
                <span className="w-16 text-[11px] text-subtle">{i === 0 ? 'Primary' : 'Duplicate'}</span>
                <Link href={`/admin/leads/${l.id}`} className="min-w-0 flex-1 truncate hover:underline">{l.fullName}<span className="text-subtle"> · {l.company ?? '—'} · {l.source ?? '—'}</span></Link>
                <StatusBadge status={l.allocationStatus} />
                <span className="w-24 text-right text-[11px] text-subtle">{fmtDate(l.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <Card><Pagination page={page} pageSize={10} total={data.total} onPage={setPage} className="border-0" /></Card>
      <ConfirmDialog open={!!merge} onOpenChange={(o) => !o && setMerge(null)} title={`Merge into ${merge?.label}`} requireReason confirmLabel="Merge" description={`${merge?.dups.length} duplicate(s) will be archived and linked to the primary record. This is recorded in the audit log.`}
        onConfirm={(reason) => m.mutateAsync({ primaryId: merge!.primary, duplicateIds: merge!.dups, reason })} />
    </div>
  );
}
