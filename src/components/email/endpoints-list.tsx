'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Radio, Webhook, Zap } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { DataTable } from '@/components/data/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { errorMessage } from '@/lib/api-client';
import { ENDPOINT_EVENTS } from '@/lib/email/endpoints';
import { fmtAgo, fmtInt, fmtPct } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';

type Stats = { triggers: number; triggers24h: number; accepted: number; filtered: number; queued: number; sent: number; failed: number; skipped: number; opened: number; clicked: number };
type Ep = {
  id: string; name: string; slug: string; description: string | null; status: string; triggerType: 'EVENT' | 'WEBHOOK'; event: string | null; category: string;
  lastTriggeredAt: string | null; emails: { templateId: string; name: string; delayMinutes: number; enabled: boolean }[]; stats: Stats | null;
};

export function EndpointsList({ base }: { base: string }) {
  const router = useRouter();
  const { data, error, isFetching } = useApiQuery<{ endpoints: Ep[] }>('/api/v1/email/endpoints', { refetchInterval: 15_000 });
  const columns: ColumnDef<Ep, unknown>[] = [
    {
      id: 'name', header: 'Endpoint', cell: ({ row: { original: e } }) => (
        <div className="flex min-w-[220px] items-start gap-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-surface-3 text-muted">{e.triggerType === 'WEBHOOK' ? <Webhook className="size-3.5" /> : <Zap className="size-3.5" />}</span>
          <div className="min-w-0"><div className="truncate text-fg">{e.name}</div><div className="truncate text-[11px] text-subtle">{e.triggerType === 'WEBHOOK' ? `Webhook · /${e.slug}` : ENDPOINT_EVENTS.find((x) => x.key === e.event)?.label ?? e.event}</div></div>
        </div>
      ),
    },
    { id: 'status', header: 'Status', cell: ({ row: { original: e } }) => <span className="flex gap-1"><Badge tone={e.status === 'ACTIVE' ? 'ok' : 'neutral'} dot>{e.status === 'ACTIVE' ? 'Active' : 'Paused'}</Badge>{e.category === 'MARKETING' && <Badge>Marketing</Badge>}</span> },
    { id: 'emails', header: 'Emails', cell: ({ row: { original: e } }) => <span className="block max-w-[220px] truncate text-muted" title={e.emails.map((x) => x.name).join(' → ')}>{e.emails.length ? e.emails.map((x) => x.name).join(' → ') : '—'}</span> },
    { id: 'triggers', header: 'Triggers · 30d', cell: ({ row: { original: e } }) => <span className="tnum">{fmtInt(e.stats?.triggers ?? 0)}<span className="text-subtle"> · {fmtInt(e.stats?.triggers24h ?? 0)} today</span></span> },
    { id: 'sent', header: 'Sent', cell: ({ row: { original: e } }) => <span className="tnum">{fmtInt(e.stats?.sent ?? 0)}{(e.stats?.failed ?? 0) > 0 && <span className="text-danger"> · {e.stats!.failed} failed</span>}</span> },
    { id: 'engagement', header: 'Opens / clicks', cell: ({ row: { original: e } }) => <span className="tnum text-muted">{fmtPct(e.stats?.sent ? e.stats.opened / e.stats.sent : null, 0)} / {fmtPct(e.stats?.sent ? e.stats.clicked / e.stats.sent : null, 0)}</span> },
    { id: 'last', header: 'Last triggered', cell: ({ row: { original: e } }) => <span className="text-subtle">{e.lastTriggeredAt ? fmtAgo(e.lastTriggeredAt) : 'Never'}</span> },
  ];
  if (error) return <ErrorState description={errorMessage(error)} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs text-subtle">An endpoint sends the emails you attach to it whenever its trigger fires: a markeetor event (a lead is added, leads are delivered, an order is placed…) or a call to its own webhook URL from any other system. Every trigger and email is logged.</p>
        <div className="flex gap-2">
          <Button onClick={() => router.push(`${base}/email/endpoints/new?type=webhook`)}><Webhook /> New webhook</Button>
          <Button variant="primary" onClick={() => router.push(`${base}/email/endpoints/new?type=event`)}><Plus /> New endpoint</Button>
        </div>
      </div>
      {data && !data.endpoints.length ? (
        <Card>
          <EmptyState icon={Radio} title="No endpoints yet" description="Create one to email people automatically when something happens, e.g. a welcome note for every new lead or an order confirmation from your website."
            action={<Button variant="primary" size="sm" onClick={() => router.push(`${base}/email/endpoints/new?type=event`)}><Plus /> New endpoint</Button>} />
        </Card>
      ) : (
        <DataTable columns={columns} data={data?.endpoints ?? []} total={data?.endpoints.length ?? 0} page={1} pageSize={500} onPage={() => {}} loading={isFetching} getRowId={(r) => r.id}
          onRowClick={(r) => router.push(`${base}/email/endpoints/${r.id}`)} />
      )}
    </div>
  );
}
