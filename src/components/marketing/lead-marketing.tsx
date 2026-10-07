'use client';
import { useQueryClient } from '@tanstack/react-query';
import { MessageCircle, MessageSquareText, Plus, Send, Workflow, X } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';
import { useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Dialog } from '@/components/ui/overlay';
import { InlineNotice } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { useApiQuery } from '@/lib/hooks';
import { MERGE_TAGS, type MarketingFeature } from '@/lib/marketing';

type LeadMkt = {
  rows: { id: string; sequenceId: string; name: string; status: string; stepIndex: number; steps: number; nextRunAt: string | null; stopReason: string | null }[];
  features: Record<MarketingFeature, boolean>; pricing: { whatsapp: number; sms: number };
  channels: { whatsapp: boolean; sms: boolean; liveWhatsapp: boolean; liveSms: boolean };
};

const nextRun = (d: string) => (new Date(d).getTime() <= Date.now() ? 'due now' : `next in ${formatDistanceToNowStrict(new Date(d))}`);

/** Send WhatsApp/SMS from the platform and manage this lead's follow-up sequences. */
export function LeadMarketing({ id, consent, canSend, canSequence, hasPhone }: { id: string; consent: Record<string, string>; canSend: boolean; canSequence: boolean; hasPhone: boolean }) {
  const qc = useQueryClient();
  const key = `/api/v1/marketing/leads/${id}/sequences`;
  const { data } = useApiQuery<LeadMkt>(key);
  const seqs = useApiQuery<{ rows: { id: string; name: string; status: string }[] }>(canSequence && data?.features.sequences ? '/api/v1/marketing/sequences' : null);
  const [send, setSend] = useState<null | { channel: 'WHATSAPP' | 'SMS'; body: string }>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState('');
  if (!data) return null;
  const chans = (['WHATSAPP', 'SMS'] as const).filter((c) => data.channels[c === 'WHATSAPP' ? 'whatsapp' : 'sms']);
  const showSend = canSend && hasPhone && chans.length > 0;
  const showSeq = data.features.sequences && (canSequence || data.rows.length > 0);
  if (!showSend && !showSeq) return null;
  const refresh = () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/marketing') || String(q.queryKey[0] ?? '').startsWith('/api/v1/crm') });
  const doSend = async () => {
    if (!send) return;
    setBusy(true);
    try {
      const r = await api<{ status: string; reason?: string }>(`/api/v1/marketing/leads/${id}/send`, { body: send });
      toast.success(r.status === 'LOGGED' ? 'Recorded (test mode — not delivered)' : 'Message sent');
      setSend(null); await refresh();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const active = data.rows.filter((r) => r.status === 'ACTIVE').map((r) => r.sequenceId);
  const live = send?.channel === 'WHATSAPP' ? data.channels.liveWhatsapp : data.channels.liveSms;
  return (
    <Card>
      <CardHeader title="Marketing" description="Send messages and run follow-up sequences" />
      <CardBody className="flex flex-col gap-3">
        {showSend && (
          <div className="flex flex-wrap gap-2">
            {chans.map((c) => {
              const out = consent[c] === 'OPTED_OUT';
              return <Button key={c} size="sm" variant="outline" disabled={out} className={c === 'WHATSAPP' ? 'border-ok/40 text-ok' : undefined} title={out ? 'Opted out' : undefined} onClick={() => setSend({ channel: c, body: c === 'WHATSAPP' ? 'Hi {first_name|there}, ' : '' })}>{c === 'WHATSAPP' ? <MessageCircle /> : <MessageSquareText />} Send {c === 'WHATSAPP' ? 'WhatsApp' : 'SMS'}</Button>;
            })}
          </div>
        )}
        {showSeq && (
          <div className="flex flex-col gap-2">
            {data.rows.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-[12px]">
                <Workflow className="size-3.5 shrink-0 text-info" />
                <div className="min-w-0 flex-1"><div className="truncate font-medium">{r.name}</div><div className="text-[11px] text-subtle">{r.status === 'ACTIVE' ? `Step ${r.stepIndex + 1} of ${r.steps}${r.nextRunAt ? ` · ${nextRun(r.nextRunAt)}` : ''}` : r.stopReason ? `Stopped: ${r.stopReason}` : `Step ${Math.min(r.stepIndex, r.steps)} of ${r.steps}`}</div></div>
                <StatusBadge status={r.status} />
                {canSequence && r.status === 'ACTIVE' && <Button size="xs" variant="ghost" aria-label="Remove from sequence" onClick={async () => { try { await api(`/api/v1/marketing/enrollments/${r.id}`, { method: 'DELETE' }); await refresh(); } catch (e) { toast.error(errorMessage(e)); } }}><X /></Button>}
              </div>
            ))}
            {canSequence && (
              <div className="flex gap-1.5">
                <Select className="h-8 flex-1 text-[12.5px]" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Sequence"><option value="">Add to a sequence…</option>{(seqs.data?.rows ?? []).filter((s) => s.status === 'ACTIVE' && !active.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
                <Button size="sm" disabled={!pick} onClick={async () => { try { const r = await api<{ enrolled: number }>(`/api/v1/marketing/sequences/${pick}/enroll`, { body: { clientLeadIds: [id] } }); toast.success(r.enrolled ? 'Added to sequence' : 'Already in this sequence'); setPick(''); await refresh(); } catch (e) { toast.error(errorMessage(e)); } }}><Plus /> Add</Button>
              </div>
            )}
          </div>
        )}
      </CardBody>
      {send && (
        <Dialog open onOpenChange={(o) => !o && setSend(null)} title={send.channel === 'WHATSAPP' ? 'Send WhatsApp' : 'Send SMS'} footer={<><Button variant="ghost" onClick={() => setSend(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!send.body.trim()} onClick={doSend}><Send /> Send · {send.channel === 'WHATSAPP' ? data.pricing.whatsapp : data.pricing.sms} credit{(send.channel === 'WHATSAPP' ? data.pricing.whatsapp : data.pricing.sms) === 1 ? '' : 's'}</Button></>}>
          <div className="flex flex-col gap-2">
            <Field label="Message" hint={`${send.body.length} characters`}><Textarea rows={5} autoFocus maxLength={1600} value={send.body} onChange={(e) => setSend({ ...send, body: e.target.value })} /></Field>
            <div className="flex flex-wrap gap-1">{MERGE_TAGS.map((t) => <button key={t} type="button" onClick={() => setSend({ ...send, body: `${send.body}{${t}}` })} className="rounded border border-border px-1.5 text-[10.5px] text-muted hover:text-fg">{`{${t}}`}</button>)}</div>
            {!live && <InlineNotice>Test mode: the message is recorded on the lead but not delivered until the platform connects a provider.</InlineNotice>}
          </div>
        </Dialog>
      )}
    </Card>
  );
}
