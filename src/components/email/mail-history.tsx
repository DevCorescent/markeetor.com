'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, CheckCircle2, Clock, Download, Eye, MousePointerClick, RotateCcw, Search, Send, ShieldOff, TriangleAlert, Undo2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { DataTable } from '@/components/data/data-table';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Drawer } from '@/components/ui/overlay';
import { Kpi } from '@/components/ui/page';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtDateTime, fmtInt, fmtPct } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';

type Row = {
  id: string; toEmail: string | null; toName: string | null; subject: string; status: string; error: string | null; attempts: number;
  createdAt: string; scheduledFor: string | null; sentAt: string | null; openedAt: string | null; openCount: number; clickedAt: string | null; clickCount: number;
  source: { kind: 'endpoint' | 'campaign'; id: string; name: string } | null;
};
type History = { total: number; summary: Record<string, number>; rows: Row[] };
type Detail = Row & {
  cc: (string | null)[]; bcc: (string | null)[]; providerMessageId: string | null; preview: string | null; canResend: boolean; canCancel: boolean;
  trigger: { id: string; source: string; status: string; createdAt: string; ip: string | null } | null;
  events: { id: string; type: string; detail: string | null; url: string | null; ip: string | null; userAgent: string | null; createdAt: string }[];
};

const STATUSES = ['', 'QUEUED', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED'];
const EVENT_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  QUEUED: Clock, DEFERRED: Clock, SENT: CheckCircle2, RETRY: RotateCcw, FAILED: XCircle, SKIPPED: Ban, CANCELLED: Ban,
  OPENED: Eye, CLICKED: MousePointerClick, UNSUBSCRIBED: ShieldOff, RESENT: Send,
};
const EVENT_TONE: Record<string, string> = { SENT: 'text-ok', OPENED: 'text-ok', CLICKED: 'text-ok', FAILED: 'text-danger', RETRY: 'text-warn', DEFERRED: 'text-warn', UNSUBSCRIBED: 'text-warn' };

/** Searchable history of every platform email (campaigns and endpoints) with a per-message timeline. */
export function MailHistory({ endpointId, base = '/admin', canManage }: { endpointId?: string; base?: string; canManage: boolean }) {
  const [f, setF] = useState({ q: '', status: '', engagement: '', kind: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const qs = new URLSearchParams({
    page: String(page), pageSize: '50', ...(endpointId ? { endpointId } : {}),
    ...Object.fromEntries(Object.entries(f).filter(([, v]) => v).map(([k, v]) => [k, k === 'to' ? `${v}T23:59:59` : v])),
  }).toString();
  const { data, error, isFetching } = useApiQuery<History>(`/api/v1/email/history?${qs}`, { refetchInterval: 10_000 });
  const set = (patch: Partial<typeof f>) => { setF({ ...f, ...patch }); setPage(1); };
  const s = data?.summary ?? {};
  const sent = s.SENT ?? 0;

  const columns: ColumnDef<Row, unknown>[] = [
    { id: 'to', header: 'Recipient', cell: ({ row: { original: m } }) => <div className="min-w-[160px]"><div className="truncate text-fg">{m.toName ?? '—'}</div><div className="font-mono text-[11px] text-subtle">{m.toEmail}</div></div> },
    { id: 'subject', header: 'Email', cell: ({ row: { original: m } }) => <div className="max-w-[300px]"><div className="truncate">{m.subject}</div>{m.source && <div className="truncate text-[11px] text-subtle">{m.source.kind === 'endpoint' ? 'Endpoint' : 'Campaign'} · {m.source.name}</div>}</div> },
    {
      id: 'status', header: 'Status', cell: ({ row: { original: m } }) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={m.status} />
          {m.openedAt && <Badge tone="ok">Opened{m.openCount > 1 ? ` ×${m.openCount}` : ''}</Badge>}
          {m.clickedAt && <Badge tone="ok">Clicked{m.clickCount > 1 ? ` ×${m.clickCount}` : ''}</Badge>}
        </span>
      ),
    },
    { id: 'detail', header: 'Detail', cell: ({ row: { original: m } }) => <span className="block max-w-[260px] truncate text-[11.5px] text-muted" title={m.error ?? ''}>{m.status === 'QUEUED' && m.scheduledFor ? `Sends ${fmtDateTime(m.scheduledFor)}` : m.error ?? (m.sentAt ? `Sent ${fmtDateTime(m.sentAt)}` : '—')}</span> },
    { id: 'at', header: 'Created', cell: ({ row: { original: m } }) => <span className="text-subtle" title={fmtDateTime(m.createdAt)}>{fmtAgo(m.createdAt)}</span> },
  ];

  if (error) return <ErrorState description={errorMessage(error)} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
        <Kpi label="Matching" value={fmtInt(data?.total ?? 0)} />
        <Kpi label="Sent" value={fmtInt(sent)} />
        <Kpi label="Queued" value={fmtInt((s.QUEUED ?? 0) + (s.SENDING ?? 0))} />
        <Kpi label="Failed" value={fmtInt(s.FAILED ?? 0)} />
        <Kpi label="Skipped" value={fmtInt((s.SKIPPED ?? 0) + (s.CANCELLED ?? 0))} />
        <Kpi label="Opened" value={fmtPct(sent ? (s.opened ?? 0) / sent : null, 0)} sub={`${fmtInt(s.opened ?? 0)} people`} />
        <Kpi label="Clicked" value={fmtPct(sent ? (s.clicked ?? 0) / sent : null, 0)} sub={`${fmtInt(s.clicked ?? 0)} people`} />
      </div>
      <DataTable columns={columns} data={data?.rows ?? []} total={data?.total ?? 0} page={page} pageSize={50} onPage={setPage} loading={isFetching} getRowId={(r) => r.id} dense
        onRowClick={(r) => setOpen(r.id)}
        empty={<EmptyState icon={Send} title="No emails match" description="Change the filters, or trigger an endpoint to see its emails here." />}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-60"><Search className="absolute top-2 left-2.5 size-3.5 text-subtle" /><Input className="h-7 pl-8" placeholder="Full email, name or subject" value={f.q} onChange={(e) => set({ q: e.target.value })} /></div>
            <div className="flex items-center rounded-md border border-border bg-surface p-0.5">
              {STATUSES.map((st) => <button key={st} onClick={() => set({ status: st })} className={cn('h-6 rounded px-2 text-[11.5px]', f.status === st ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{st ? st[0] + st.slice(1).toLowerCase() : 'All'}</button>)}
            </div>
            <Select className="h-7 w-36 text-[12px]" value={f.engagement} onChange={(e) => set({ engagement: e.target.value })} aria-label="Engagement">
              <option value="">Any engagement</option><option value="opened">Opened</option><option value="clicked">Clicked</option><option value="not_opened">Sent, not opened</option>
            </Select>
            {!endpointId && (
              <Select className="h-7 w-32 text-[12px]" value={f.kind} onChange={(e) => set({ kind: e.target.value })} aria-label="Source">
                <option value="">All sources</option><option value="endpoint">Endpoints</option><option value="campaign">Campaigns</option>
              </Select>
            )}
            <Input type="date" className="h-7 w-36 text-[12px]" value={f.from} onChange={(e) => set({ from: e.target.value })} aria-label="From date" />
            <Input type="date" className="h-7 w-36 text-[12px]" value={f.to} onChange={(e) => set({ to: e.target.value })} aria-label="To date" />
            <a href={`/api/v1/email/history/export?${qs}`} className="ml-auto"><Button size="sm" variant="ghost"><Download /> Export CSV</Button></a>
          </div>
        } />
      <MessageDrawer id={open} onClose={() => setOpen(null)} base={base} canManage={canManage} />
    </div>
  );
}

function MessageDrawer({ id, onClose, base, canManage }: { id: string | null; onClose: () => void; base: string; canManage: boolean }) {
  const { data, error, isLoading } = useApiQuery<Detail>(id ? `/api/v1/email/history/${id}` : null, { refetchInterval: 10_000 });
  const resend = useApiMutation((mid: string) => api<{ id: string }>(`/api/v1/email/history/${mid}/resend`, { method: 'POST' }), { success: 'Queued to send again', invalidate: ['/api/v1/email/history'] });
  const cancel = useApiMutation((mid: string) => api(`/api/v1/email/history/${mid}/cancel`, { method: 'POST' }), { success: 'Email cancelled', invalidate: ['/api/v1/email/history'] });
  const [tab, setTab] = useState<'timeline' | 'preview'>('timeline');
  return (
    <Drawer open={!!id} onOpenChange={(o) => !o && onClose()} width="lg" title={data ? data.subject : 'Email'} description={data ? `${data.toName ? `${data.toName} · ` : ''}${data.toEmail ?? ''}` : undefined}
      footer={data && canManage && (data.canResend || data.canCancel) ? (
        <div className="flex justify-end gap-2">
          {data.canCancel && <Button loading={cancel.isPending} onClick={() => cancel.mutate(data.id)}><Undo2 /> Cancel</Button>}
          {data.canResend && <Button variant="primary" loading={resend.isPending} onClick={() => resend.mutate(data.id)}><RotateCcw /> Send again</Button>}
        </div>
      ) : undefined}>
      {error ? <ErrorState description={errorMessage(error)} /> : isLoading || !data ? <Skeleton className="h-96" /> : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={data.status} />
            {data.openedAt && <Badge tone="ok">Opened {data.openCount}×</Badge>}
            {data.clickedAt && <Badge tone="ok">Clicked {data.clickCount}×</Badge>}
            {data.attempts > 1 && <Badge tone="warn">{data.attempts} attempts</Badge>}
          </div>
          {data.error && data.status !== 'SENT' && <div className="flex gap-2 rounded-md border border-border bg-surface-2 p-3 text-[12.5px] text-muted"><TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />{data.error}</div>}
          <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
            <dt className="text-subtle">Source</dt>
            <dd>{data.source ? <Link className="hover:underline" href={data.source.kind === 'endpoint' ? `${base}/email/endpoints/${data.source.id}` : `${base}/email/campaigns/${data.source.id}`}>{data.source.kind === 'endpoint' ? 'Endpoint' : 'Campaign'} · {data.source.name}</Link> : '—'}</dd>
            {data.trigger && <><dt className="text-subtle">Trigger</dt><dd>{data.trigger.source.toLowerCase()} · {fmtDateTime(data.trigger.createdAt)}{data.trigger.ip ? ` · ${data.trigger.ip}` : ''}</dd></>}
            <dt className="text-subtle">Created</dt><dd>{fmtDateTime(data.createdAt)}</dd>
            {data.scheduledFor && data.status === 'QUEUED' && <><dt className="text-subtle">Scheduled</dt><dd>{fmtDateTime(data.scheduledFor)}</dd></>}
            <dt className="text-subtle">Sent</dt><dd>{data.sentAt ? fmtDateTime(data.sentAt) : '—'}</dd>
            {data.cc.length > 0 && <><dt className="text-subtle">CC</dt><dd className="font-mono text-[11.5px]">{data.cc.join(', ')}</dd></>}
            {data.bcc.length > 0 && <><dt className="text-subtle">BCC</dt><dd className="font-mono text-[11.5px]">{data.bcc.join(', ')}</dd></>}
            {data.providerMessageId && <><dt className="text-subtle">Message ID</dt><dd className="truncate font-mono text-[11px]" title={data.providerMessageId}>{data.providerMessageId}</dd></>}
          </dl>
          <div className="flex items-center rounded-md border border-border bg-surface p-0.5 self-start">
            {(['timeline', 'preview'] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={cn('h-7 rounded px-3 text-[12px] capitalize', tab === t ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{t}</button>)}
          </div>
          {tab === 'timeline' ? (
            <ol className="relative flex flex-col gap-3 border-l border-border pl-5">
              {data.events.length === 0 && <li className="text-[12.5px] text-subtle">Queued {fmtDateTime(data.createdAt)}. Detailed events are recorded for emails sent after history tracking was added.</li>}
              {data.events.map((e) => {
                const Icon = EVENT_ICON[e.type] ?? Clock;
                return (
                  <li key={e.id} className="relative">
                    <span className={cn('absolute -left-[27px] grid size-[13px] place-items-center rounded-full bg-bg', EVENT_TONE[e.type] ?? 'text-subtle')}><Icon className="size-3.5" /></span>
                    <div className="flex items-baseline justify-between gap-3"><span className="text-[12.5px] font-medium">{e.type[0] + e.type.slice(1).toLowerCase()}</span><span className="shrink-0 text-[11px] text-subtle">{fmtDateTime(e.createdAt)}</span></div>
                    {e.detail && <div className="text-[12px] break-words text-muted">{e.detail}</div>}
                    {e.url && <a href={e.url} target="_blank" rel="noreferrer noopener" className="block truncate text-[11.5px] text-accent hover:underline">{e.url}</a>}
                    {(e.ip || e.userAgent) && <div className="truncate text-[11px] text-subtle" title={e.userAgent ?? ''}>{[e.ip, e.userAgent].filter(Boolean).join(' · ')}</div>}
                  </li>
                );
              })}
            </ol>
          ) : data.preview ? (
            <iframe title="Email preview" sandbox="" srcDoc={data.preview} className="h-[560px] w-full rounded-md border border-border bg-white" />
          ) : <p className="text-[12.5px] text-subtle">The preview is no longer available: this email’s details were erased by the retention policy.</p>}
        </div>
      )}
    </Drawer>
  );
}
