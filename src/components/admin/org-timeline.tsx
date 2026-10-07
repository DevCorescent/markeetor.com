'use client';
import { Coins, FileText, LogIn, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/states';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtDateTime } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { HealthCard, type Health } from './client-health';

type Item = { at: string; kind: 'audit' | 'login' | 'credits' | 'invoice'; title: string; detail: string | null; actor: string | null; tone: 'neutral' | 'good' | 'bad' | 'money' };
const KIND = { audit: { icon: ScrollText, tone: 'bg-info-dim text-info' }, login: { icon: LogIn, tone: 'bg-surface-3 text-muted' }, credits: { icon: Coins, tone: 'bg-accent-dim text-accent' }, invoice: { icon: FileText, tone: 'bg-ok-dim text-ok' } } as const;
const FILTERS = [['all', 'Everything'], ['audit', 'Actions'], ['credits', 'Credits'], ['invoice', 'Invoices'], ['login', 'Sign-ins']] as const;

/** Client 360: health score plus every action, credit movement, invoice and sign-in in one feed. */
export function OrgTimeline({ id }: { id: string }) {
  const health = useApiQuery<{ rows: Health[] }>(`/api/v1/health?organizationId=${id}`);
  const first = useApiQuery<{ items: Item[]; next: string | null }>(`/api/v1/organizations/${id}/timeline`);
  const [more, setMore] = useState<Item[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [filter, setFilter] = useState<string>('all');
  const [loading, setLoading] = useState(false);
  const items = [...(first.data?.items ?? []), ...more].filter((i) => filter === 'all' || i.kind === filter);
  const cursor = next === undefined ? first.data?.next : next;
  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    const r = await api<{ items: Item[]; next: string | null }>(`/api/v1/organizations/${id}/timeline?before=${encodeURIComponent(cursor)}`).finally(() => setLoading(false));
    setMore((m) => [...m, ...r.items]); setNext(r.next);
  };
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="self-start">{health.data?.rows[0] ? <HealthCard h={health.data.rows[0]} link={false} /> : <Skeleton className="h-48" />}</div>
      <Card>
        <CardHeader title="Account timeline" description="Purchases, credits, invoices, reports, settings changes and sign-ins" actions={
          <div className="flex flex-wrap gap-1">{FILTERS.map(([k, l]) => <button key={k} type="button" onClick={() => setFilter(k)} className={cn('rounded-full px-2.5 py-0.5 text-[11.5px]', filter === k ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{l}</button>)}</div>
        } />
        {!first.data ? <Skeleton className="m-4 h-64" /> : (
          <ol className="flex flex-col px-4 py-3">
            {items.map((i, n) => {
              const K = KIND[i.kind];
              return (
                <li key={n} className="flex gap-3">
                  <div className="flex flex-col items-center"><span className={cn('grid size-7 shrink-0 place-items-center rounded-full', i.tone === 'bad' ? 'bg-danger-dim text-danger' : K.tone)}><K.icon className="size-3.5" /></span>{n < items.length - 1 && <span className="w-px flex-1 bg-border" />}</div>
                  <div className="min-w-0 flex-1 pb-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="text-[12.5px] font-medium">{i.title}</span><span className="text-[11px] text-subtle">{fmtDateTime(i.at)}</span></div>
                    {(i.detail || i.actor) && <div className="truncate text-[11.5px] text-subtle">{[i.detail, i.actor].filter(Boolean).join(' · ')}</div>}
                  </div>
                </li>
              );
            })}
            {!items.length && <li className="py-8 text-center text-[12.5px] text-subtle">Nothing yet.</li>}
          </ol>
        )}
        {cursor && <div className="border-t border-border px-4 py-2.5"><Button size="sm" variant="ghost" loading={loading} onClick={loadMore}>Load older</Button></div>}
      </Card>
    </div>
  );
}
