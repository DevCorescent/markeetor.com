'use client';
import { RotateCcw, X } from 'lucide-react';
import { ColumnChart } from '@/components/data/charts';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, DefinitionList } from '@/components/ui/card';
import { Kpi, PageHeader } from '@/components/ui/page';
import { ErrorState, InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { fmtDateTime, fmtInt, fmtPct } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { MessageLog } from './email-hub';

type D = {
  campaign: { id: string; name: string; subject: string; preheader: string | null; status: string; totalRecipients: number; sentCount: number; failedCount: number; skippedCount: number; openedCount: number; trackOpens: boolean; scheduledFor: string | null; createdAt: string; startedAt: string | null; completedAt: string | null; error: string | null };
  sender: { label: string; fromEmail: string; fromName: string } | null;
  creator: { name: string } | null;
  html: string;
  byStatus: Record<string, number>;
  timeline: { hour: string; sent: number; opened: number }[];
};

export function CampaignDetail({ base, id, canSend }: { base: string; id: string; canSend: boolean }) {
  const { data, error } = useApiQuery<D>(`/api/v1/email/campaigns/${id}`, { refetchInterval: 4000 });
  const cancel = useApiMutation(() => api(`/api/v1/email/campaigns/${id}/cancel`, { method: 'POST' }), { success: 'Campaign cancelled', invalidate: ['/api/v1/email'] });
  const retry = useApiMutation(() => api<{ requeued: number }>(`/api/v1/email/campaigns/${id}/retry`, { method: 'POST' }), { success: (r) => `${r.requeued} message(s) re-queued`, invalidate: ['/api/v1/email'] });
  if (error) return <ErrorState description={errorMessage(error)} />;
  if (!data) return <Skeleton className="h-96" />;
  const c = data.campaign;
  const sendable = c.totalRecipients - c.skippedCount;
  const running = ['QUEUED', 'SENDING', 'SCHEDULED'].includes(c.status);
  return (
    <>
      <PageHeader crumbs={[{ label: 'Email', href: `${base}/email` }, { label: c.name }]} title={<span className="flex items-center gap-3">{c.name}<StatusBadge status={c.status} /></span>} description={`“${c.subject}” · from ${data.sender?.fromEmail ?? '—'} · by ${data.creator?.name ?? '—'}`}
        actions={canSend && (
          <>
            {running && <Button variant="ghost" onClick={() => cancel.mutate(undefined)} loading={cancel.isPending}><X /> Cancel</Button>}
            {!running && c.failedCount > 0 && <Button onClick={() => retry.mutate(undefined)} loading={retry.isPending}><RotateCcw /> Retry failed</Button>}
          </>
        )} />
      {c.error && <InlineNotice tone={running ? 'warn' : 'danger'} className="mb-4">{c.error}</InlineNotice>}
      {running && (
        <Card className="mb-4"><CardBody>
          <div className="mb-2 flex justify-between text-[12px]"><span>{c.status === 'SCHEDULED' ? `Scheduled for ${fmtDateTime(c.scheduledFor)}` : 'Sending…'}</span><span className="tnum">{fmtInt(c.sentCount + c.failedCount)} / {fmtInt(sendable)}</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-fg transition-all" style={{ width: `${sendable ? ((c.sentCount + c.failedCount) / sendable) * 100 : 0}%` }} /></div>
        </CardBody></Card>
      )}
      <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-5">
        <Kpi label="Recipients" value={fmtInt(c.totalRecipients)} />
        <Kpi label="Sent" value={fmtInt(c.sentCount)} sub={`${fmtPct(sendable ? c.sentCount / sendable : null, 0)} of sendable`} />
        <Kpi label="Opened" value={c.trackOpens ? fmtInt(c.openedCount) : '—'} sub={c.trackOpens ? `${fmtPct(c.sentCount ? c.openedCount / c.sentCount : null, 1)} open rate (approx.)` : 'tracking off'} />
        <Kpi label="Failed" value={fmtInt(c.failedCount)} />
        <Kpi label="Skipped" value={fmtInt(c.skippedCount)} />
      </div>
      <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_420px]">
        <Card>
          <CardHeader title="Sent per hour" />
          <CardBody>{data.timeline.length ? <ColumnChart data={data.timeline.map((t) => ({ label: new Date(t.hour).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' }), sent: t.sent }))} xKey="label" yKey="sent" label="Sent" /> : <p className="py-10 text-center text-xs text-subtle">Nothing sent yet</p>}</CardBody>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title="Email" description="Rendered with sample values" />
          <iframe title="Campaign email" sandbox="" srcDoc={data.html} className="h-[300px] w-full bg-white" />
          <CardBody><DefinitionList items={[['Created', fmtDateTime(c.createdAt)], ['Started', fmtDateTime(c.startedAt)], ['Completed', fmtDateTime(c.completedAt)], ['Preview text', c.preheader]]} /></CardBody>
        </Card>
      </div>
      <MessageLog campaignId={id} />
    </>
  );
}
