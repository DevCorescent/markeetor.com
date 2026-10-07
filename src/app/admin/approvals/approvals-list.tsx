'use client';
import { useState } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { EmptyState } from '@/components/ui/states';
import { api } from '@/lib/api-client';
import { fmtAgo, fmtDateTime, humanize } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';

type A = { id: string; type: string; summary: string; status: string; createdAt: string; expiresAt: string; decidedAt: string | null; decisionNote: string | null; requestedById: string; requestedBy: { name: string; email: string } | null; decidedBy: { name: string } | null };

export function ApprovalsList({ selfId }: { selfId: string }) {
  const [status, setStatus] = useState('PENDING');
  const { data } = useApiQuery<{ rows: A[] }>(`/api/v1/approvals${status ? `?status=${status}` : ''}`);
  const [decide, setDecide] = useState<{ a: A; approve: boolean } | null>(null);
  const m = useApiMutation((b: { id: string; approve: boolean; note: string }) => api(`/api/v1/approvals/${b.id}`, { body: { approve: b.approve, note: b.note } }), { success: 'Decision recorded', invalidate: ['/api/v1/approvals'] });
  return (
    <>
      <div className="mb-3 flex items-center rounded-md border border-border bg-surface p-0.5 w-fit">
        {['PENDING', 'APPROVED', 'REJECTED', ''].map((s) => <button key={s} onClick={() => setStatus(s)} className={`h-6 rounded px-2.5 text-[11.5px] ${status === s ? 'bg-fg text-inverse' : 'text-muted hover:text-fg'}`}>{s ? humanize(s) : 'All'}</button>)}
      </div>
      <Card>
        {!data?.rows.length ? <EmptyState title="Nothing here" description="No approval requests match this filter." /> : (
          <ul>
            {data.rows.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-3 last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px]">{a.summary}</div>
                  <div className="text-[11.5px] text-subtle">{humanize(a.type)} · requested by {a.requestedBy?.name ?? '—'} {fmtAgo(a.createdAt)} · {a.status === 'PENDING' ? `expires ${fmtDateTime(a.expiresAt)}` : `${a.decidedBy?.name ?? ''} ${a.decisionNote ? `— “${a.decisionNote}”` : ''}`}</div>
                </div>
                <StatusBadge status={a.status} />
                {a.status === 'PENDING' && (
                  a.requestedById === selfId ? <span className="text-[11px] text-subtle">Awaiting another approver</span> : (
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setDecide({ a, approve: false })}>Reject</Button>
                      <Button size="sm" variant="primary" onClick={() => setDecide({ a, approve: true })}>Approve</Button>
                    </div>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog open={!!decide} onOpenChange={(o) => !o && setDecide(null)} title={`${decide?.approve ? 'Approve' : 'Reject'}: ${decide?.a.summary}`} requireReason danger={!decide?.approve} confirmLabel={decide?.approve ? 'Approve' : 'Reject'}
        description="Requires identity re-verification. Your decision is recorded in the audit log." onConfirm={(note) => m.mutateAsync({ id: decide!.a.id, approve: decide!.approve, note })} />
    </>
  );
}
