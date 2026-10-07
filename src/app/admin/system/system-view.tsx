'use client';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, CircleDashed, RefreshCw, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtInt } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';

type H = {
  checkedAt: string;
  services: { database: { ok: boolean; ms: number }; redis: { ok: boolean }; worker: { ok: boolean; lastSeenSeconds: number | null }; ai: { configured: boolean }; smtp: { configured: boolean }; razorpay: { configured: boolean; webhook: boolean } };
  queues: { name: string; waiting: number; active: number; delayed: number; failed: number; completed: number; reachable: boolean }[];
  failed: { queue: string; id: string; name: string; attempts: number; reason: string; at: string | null }[];
  last24h: { emails: Record<string, number>; webhooks: Record<string, number>; enrichment: Record<string, number>; payments: Record<string, number>; alerts: number };
};

function Status({ ok, label, detail, optional }: { ok: boolean; label: string; detail?: string; optional?: boolean }) {
  const Icon = ok ? CheckCircle2 : optional ? CircleDashed : CircleAlert;
  return (
    <Card className={cn('flex items-center gap-3 px-4 py-3', !ok && !optional && 'border-danger/40')}>
      <Icon className={cn('size-5', ok ? 'text-ok' : optional ? 'text-subtle' : 'text-danger')} />
      <div><div className="text-[13px] font-medium">{label}</div><div className="text-[11.5px] text-subtle">{detail ?? (ok ? 'OK' : optional ? 'Not configured' : 'Down')}</div></div>
    </Card>
  );
}
const Counts = ({ title, map }: { title: string; map: Record<string, number> }) => (
  <div className="rounded-lg border border-border px-3 py-2.5"><div className="eyebrow mb-1.5">{title}</div>
    {Object.keys(map).length ? <div className="flex flex-wrap gap-1.5">{Object.entries(map).map(([k, v]) => <span key={k} className={cn('rounded-full px-2 py-0.5 text-[11px]', /FAIL|BOUNCE|ERROR/i.test(k) ? 'bg-danger-dim text-danger' : /DONE|SENT|DELIVERED|PAID/i.test(k) ? 'bg-ok-dim text-ok' : 'bg-surface-3 text-muted')}>{k.toLowerCase().replace(/_/g, ' ')} {fmtInt(v)}</span>)}</div> : <span className="text-[11.5px] text-subtle">None</span>}
  </div>
);

export function SystemView() {
  const qc = useQueryClient();
  const { data: h, isFetching, refetch } = useApiQuery<H>('/api/v1/system/health', { refetchInterval: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const retry = async (queue: string, id?: string) => {
    setBusy(`${queue}:${id ?? '*'}`);
    try { const r = await api<{ retried?: number }>('/api/v1/system/retry', { body: { queue, id } }); toast.success(id ? 'Job retried' : `${r.retried ?? 0} jobs retried`); await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/system') }); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  return (
    <>
      <PageHeader eyebrow="Governance" title="System health" description="Database, cache, background worker, job queues and integrations — refreshed every 30 seconds."
        actions={<Button variant="ghost" onClick={() => refetch()}><RefreshCw className={isFetching ? 'animate-spin' : ''} /> Refresh</Button>} />
      {!h ? <Skeleton className="h-96" /> : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Status ok={h.services.database.ok} label="Database" detail={h.services.database.ok ? `${h.services.database.ms} ms` : undefined} />
            <Status ok={h.services.redis.ok} label="Redis" />
            <Status ok={h.services.worker.ok} label="Worker" detail={h.services.worker.lastSeenSeconds == null ? 'No heartbeat' : `Seen ${h.services.worker.lastSeenSeconds}s ago`} />
            <Status ok={h.services.smtp.configured} optional label="Email (SMTP)" />
            <Status ok={h.services.ai.configured} optional label="AI provider" />
            <Status ok={h.services.razorpay.configured} optional label="Razorpay" detail={h.services.razorpay.configured ? (h.services.razorpay.webhook ? 'Keys + webhook' : 'Keys, no webhook secret') : undefined} />
          </div>
          <Card>
            <CardHeader title="Job queues" description={`Checked ${fmtAgo(h.checkedAt)}`} />
            <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-[12.5px]">
              <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">{['Queue', 'Waiting', 'Active', 'Delayed', 'Failed', 'Completed (kept)', ''].map((x) => <th key={x} className="h-9 px-4 font-medium">{x}</th>)}</tr></thead>
              <tbody>{h.queues.map((q) => (
                <tr key={q.name} className="border-b border-border/60 last:border-0">
                  <td className="px-4 py-2 font-medium">{q.name}{!q.reachable && <span className="ml-2 text-[11px] text-danger">unreachable</span>}</td>
                  <td className={cn('tnum px-4', q.waiting > 100 && 'font-medium text-warn')}>{fmtInt(q.waiting)}</td><td className="tnum px-4">{fmtInt(q.active)}</td><td className="tnum px-4">{fmtInt(q.delayed)}</td>
                  <td className={cn('tnum px-4', q.failed > 0 && 'font-medium text-danger')}>{fmtInt(q.failed)}</td><td className="tnum px-4 text-subtle">{fmtInt(q.completed)}</td>
                  <td className="px-4 text-right">{q.failed > 0 && <Button size="xs" variant="outline" loading={busy === `${q.name}:*`} onClick={() => retry(q.name)}><RotateCcw /> Retry all</Button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Card>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader title="Recent failed jobs" />
              <ul className="flex max-h-[420px] flex-col divide-y divide-border overflow-y-auto">
                {h.failed.map((j) => (
                  <li key={`${j.queue}:${j.id}`} className="flex items-start gap-3 px-4 py-2.5 text-[12.5px]">
                    <div className="min-w-0 flex-1"><div className="font-medium">{j.queue}/{j.name} <span className="font-mono text-[11px] text-subtle">#{j.id}</span></div><div className="truncate text-[11.5px] text-danger">{j.reason}</div><div className="text-[11px] text-subtle">{j.attempts} attempts{j.at ? ` · ${fmtAgo(j.at)}` : ''}</div></div>
                    <Button size="xs" variant="ghost" loading={busy === `${j.queue}:${j.id}`} onClick={() => retry(j.queue, j.id)}><RotateCcw /> Retry</Button>
                  </li>
                ))}
                {!h.failed.length && <li className="px-4 py-8 text-center text-[12.5px] text-subtle">No failed jobs.</li>}
              </ul>
            </Card>
            <Card className="self-start">
              <CardHeader title="Last 24 hours" />
              <CardBody className="flex flex-col gap-2">
                <Counts title="Emails" map={h.last24h.emails} /><Counts title="Webhooks" map={h.last24h.webhooks} /><Counts title="Lead research" map={h.last24h.enrichment} /><Counts title="Online payments" map={h.last24h.payments} />
                <div className="rounded-lg border border-border px-3 py-2.5 text-[12px]"><span className="eyebrow">Alerts fired</span> <b className="tnum ml-2">{fmtInt(h.last24h.alerts)}</b></div>
              </CardBody>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
