'use client';
import { HeartPulse, Rocket, ShieldAlert, Eye } from 'lucide-react';
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/states';
import { cn } from '@/lib/cn';
import { fmtInt } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';
import { HealthCard, type Health } from '@/components/admin/client-health';

export function HealthView() {
  const { data } = useApiQuery<{ rows: Health[] }>('/api/v1/health', { refetchInterval: 120_000 });
  const [s, set] = useUrlState({ filter: 'all' });
  const [q, setQ] = useState('');
  const rows = data?.rows ?? [];
  const count = (f: string) => rows.filter((r) => (f === 'grow' ? r.expansion : r.status === f)).length;
  const shown = rows.filter((r) => (s.filter === 'all' || (s.filter === 'grow' ? r.expansion : r.status === s.filter)) && (!q || r.name.toLowerCase().includes(q.toLowerCase())));
  const tiles = [
    { key: 'all', label: 'All clients', n: rows.length, icon: HeartPulse, tone: 'bg-info-dim text-info' },
    { key: 'at_risk', label: 'At risk', n: count('at_risk'), icon: ShieldAlert, tone: 'bg-danger-dim text-danger' },
    { key: 'watch', label: 'Watch', n: count('watch'), icon: Eye, tone: 'bg-warn-dim text-warn' },
    { key: 'grow', label: 'Ready to grow', n: count('grow'), icon: Rocket, tone: 'bg-accent-dim text-accent' },
  ];
  return (
    <>
      <PageHeader eyebrow="Clients" title="Client health" description="A 0–100 score per client from the last 30 days: sign-ins and activity, how fast they work leads, buying trend and quality reports — with the reasons." />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((t) => (
          <button key={t.key} type="button" onClick={() => set({ filter: t.key })} className={cn('flex items-center gap-3 rounded-lg border bg-surface px-4 py-3 text-left', s.filter === t.key ? 'border-fg ring-1 ring-fg' : 'border-border hover:border-border-strong')}>
            <span className={cn('grid size-9 place-items-center rounded-lg', t.tone)}><t.icon className="size-4" /></span>
            <span><span className="tnum block text-[22px] leading-none font-semibold">{fmtInt(t.n)}</span><span className="text-[11.5px] text-subtle">{t.label}</span></span>
          </button>
        ))}
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client…" className="mb-3 max-w-xs" aria-label="Find a client" />
      {!data ? <Skeleton className="h-96" /> : shown.length ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">{shown.map((h) => <HealthCard key={h.organizationId} h={h} />)}</div>
      ) : <Card className="py-12 text-center text-[12.5px] text-subtle">No clients in this group.</Card>}
    </>
  );
}
