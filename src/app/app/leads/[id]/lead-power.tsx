'use client';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, Check, Copy, Lightbulb, Loader2, MessageCircle, Phone, PhoneCall, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog } from '@/components/ui/overlay';
import { InlineNotice } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtDate } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';

const invalidateLead = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/crm') });
const waNumber = (p: string) => p.replace(/[^\d]/g, '');

// ── One-tap contact ────────────────────────────────────────────────

const CALL_OUTCOMES = [['CONNECTED', 'Connected', 'ok'], ['NO_ANSWER', 'No answer', 'neutral'], ['BUSY', 'Busy', 'neutral'], ['VOICEMAIL', 'Voicemail', 'neutral'], ['WRONG_NUMBER', 'Wrong number', 'danger']] as const;

/** Call or WhatsApp in one tap: reveals the number (logged), opens the dialer / WhatsApp, then logs the outcome. */
export function ContactNow({ id, channel, requireReason, consent, onWrongNumber }: { id: string; channel: 'CALL' | 'WHATSAPP'; requireReason: boolean; consent: Record<string, string>; onWrongNumber: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const optedOut = consent[channel] === 'OPTED_OUT';
  const reveal = async () => {
    setBusy('reveal');
    try {
      const r = await api<{ value: string | null }>(`/api/v1/crm/leads/${id}/reveal`, { body: { field: 'phone', reason: reason || undefined } });
      if (!r.value) throw new Error('No phone number on this lead');
      setPhone(r.value);
      if (channel === 'CALL') window.location.href = `tel:${r.value.replace(/\s+/g, '')}`;
      else window.open(`https://wa.me/${waNumber(r.value)}`, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const log = async (outcome: string) => {
    setBusy(outcome);
    try {
      await api(`/api/v1/crm/leads/${id}/comms`, { body: { channel, direction: 'OUTBOUND', outcome, body: notes || null } });
      toast.success('Logged');
      await invalidateLead(qc);
      setOpen(false); setPhone(null); setNotes('');
      if (outcome === 'WRONG_NUMBER') onWrongNumber();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const Icon = channel === 'CALL' ? PhoneCall : MessageCircle;
  return (
    <>
      <Button variant={channel === 'CALL' ? 'primary' : 'outline'} disabled={optedOut} onClick={() => setOpen(true)} className={channel === 'WHATSAPP' ? 'border-ok/40 text-ok' : undefined}><Icon /> {channel === 'CALL' ? 'Call' : 'WhatsApp'}</Button>
      <Dialog open={open} onOpenChange={(o) => { if (!o) { setOpen(false); setPhone(null); } }} title={channel === 'CALL' ? 'Call this lead' : 'Message on WhatsApp'} size="sm"
        description={phone ? 'How did it go? Logging keeps your pipeline and reports accurate.' : 'The number is revealed and the reveal is logged.'}
        footer={phone ? undefined : <><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy === 'reveal'} disabled={requireReason && reason.trim().length < 3} onClick={reveal}><Icon /> {channel === 'CALL' ? 'Reveal & call' : 'Reveal & open WhatsApp'}</Button></>}>
        {!phone ? (
          requireReason ? <Field label="Reason for revealing" hint="Required by your workspace"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. First call" autoFocus /></Field> : <p className="text-[12.5px] text-muted">You’ll be connected right away.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
              <span className="font-mono text-[14px]">{phone}</span>
              <a href={channel === 'CALL' ? `tel:${phone.replace(/\s+/g, '')}` : `https://wa.me/${waNumber(phone)}`} target={channel === 'WHATSAPP' ? '_blank' : undefined} rel="noopener noreferrer" className="text-[12px] text-info hover:underline">{channel === 'CALL' ? 'Call again' : 'Open WhatsApp'}</a>
            </div>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" />
            <div className="grid grid-cols-2 gap-2">
              {(channel === 'CALL' ? CALL_OUTCOMES : ([['SENT', 'Message sent', 'ok'], ['REPLIED', 'They replied', 'ok'], ['WRONG_NUMBER', 'Wrong number', 'danger']] as const)).map(([k, label, tone]) => (
                <button key={k} type="button" disabled={Boolean(busy)} onClick={() => log(k)} className={cn('flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-[12.5px] font-medium transition-colors disabled:opacity-50', tone === 'ok' ? 'border-ok/30 bg-ok-dim text-ok' : tone === 'danger' ? 'border-danger/30 bg-danger-dim text-danger' : 'border-border hover:border-border-strong')}>
                  {busy === k ? <Loader2 className="size-3.5 animate-spin" /> : null}{label}
                </button>
              ))}
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

// ── Lead quality guarantee ─────────────────────────────────────────

type Eligibility = { eligible: boolean; reason: string | null; until: string; windowDays: number; refundPct: number; reasons: { key: string; label: string }[]; dispute: { code: string; status: string; reasonLabel: string; resolution: string | null; refundCredits: number; createdAt: string } | null };

export function ReportProblem({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { data } = useApiQuery<Eligibility>(`/api/v1/crm/leads/${id}/dispute`);
  const [reason, setReason] = useState('WRONG_NUMBER');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ status: string; code: string; refundCredits: number }>(`/api/v1/crm/leads/${id}/dispute`, { body: { reason, details: details || undefined } });
      toast.success(r.status === 'APPROVED' ? `Approved — ${r.refundCredits.toLocaleString()} credits refunded` : `Reported (${r.code})`, { description: r.status === 'APPROVED' ? undefined : 'The platform team will review it shortly.' });
      await qc.invalidateQueries({ predicate: (q) => /\/dispute|\/credits/.test(String(q.queryKey[0] ?? '')) });
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!data) return null;
  const d = data.dispute;
  const show = data.eligible || d;
  return (
    <>
      {show && (
        <Button variant="ghost" onClick={() => onOpenChange(true)} className={d ? (d.status === 'APPROVED' ? 'text-ok' : d.status === 'REJECTED' ? 'text-muted' : 'text-warn') : 'text-muted'}>
          {d ? <><ShieldCheck /> Report {d.status.toLowerCase()}</> : <><AlertTriangle /> Report a problem</>}
        </Button>
      )}
      <Dialog open={open} onOpenChange={onOpenChange} size="sm" title={d ? `Report ${d.code}` : 'Report a problem with this lead'}
        description={d ? undefined : `Covered by the lead quality guarantee until ${fmtDate(data.until)}. Approved reports are refunded ${data.refundPct}% in credits.`}
        footer={d ? <Button onClick={() => onOpenChange(false)}>Close</Button> : <><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!data.eligible} onClick={submit}>Submit report</Button></>}>
        {d ? (
          <div className="flex flex-col gap-2 text-[12.5px]">
            <div className="flex justify-between"><span className="text-subtle">Reason</span><span>{d.reasonLabel}</span></div>
            <div className="flex justify-between"><span className="text-subtle">Status</span><span className={d.status === 'APPROVED' ? 'font-medium text-ok' : d.status === 'REJECTED' ? 'text-muted' : 'text-warn'}>{d.status === 'OPEN' ? 'Under review' : d.status === 'APPROVED' ? 'Approved' : 'Not approved'}</span></div>
            {d.status === 'APPROVED' && <div className="flex justify-between"><span className="text-subtle">Refunded</span><span className="tnum font-medium">{d.refundCredits.toLocaleString()} credits</span></div>}
            {d.resolution && <InlineNotice>{d.resolution}</InlineNotice>}
          </div>
        ) : !data.eligible ? <InlineNotice>{data.reason}</InlineNotice> : (
          <div className="flex flex-col gap-3">
            <Field label="What’s wrong?"><Select value={reason} onChange={(e) => setReason(e.target.value)}>{data.reasons.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</Select></Field>
            <Field label="Details" hint="What you tried — helps the review go faster"><Textarea rows={3} value={details} maxLength={1000} onChange={(e) => setDetails(e.target.value)} placeholder="e.g. Called twice, number not in service" /></Field>
          </div>
        )}
      </Dialog>
    </>
  );
}

// ── AI assistant ───────────────────────────────────────────────────

type Assistant = { actions: { title: string; why: string; channel: string; urgency: 'now' | 'today' | 'soon' }[]; draft?: { subject: string | null; body: string }; engine: string };
const URGENCY = { now: 'bg-danger-dim text-danger', today: 'bg-warn-dim text-warn', soon: 'bg-info-dim text-info' } as const;

export function AssistantCard({ id }: { id: string }) {
  const { data, refetch, isFetching } = useApiQuery<Assistant>(`/api/v1/crm/leads/${id}/assistant`);
  const [draft, setDraft] = useState<Assistant['draft'] & { kind: string; engine: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const write = async (kind: 'intro' | 'followup' | 'whatsapp') => {
    setBusy(kind);
    try {
      const r = await api<Assistant>(`/api/v1/crm/leads/${id}/assistant`, { body: { draft: kind } });
      if (r.draft) setDraft({ ...r.draft, kind, engine: r.engine });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const copy = async () => {
    if (!draft) return;
    await navigator.clipboard?.writeText(draft.subject ? `Subject: ${draft.subject}\n\n${draft.body}` : draft.body);
    toast.success('Copied');
  };
  return (
    <Card className="overflow-hidden">
      <CardHeader title={<span className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-md bg-gradient-to-br from-accent to-info text-white"><Bot className="size-3.5" /></span>AI assistant</span>}
        description="Next best action and ready-to-send messages for this lead" actions={<Button size="xs" variant="ghost" aria-label="Refresh" onClick={() => refetch()}><RefreshCw className={isFetching ? 'animate-spin' : ''} /></Button>} />
      <CardBody className="flex flex-col gap-3">
        {!data ? <div className="h-16 animate-pulse rounded-md bg-surface-2" /> : data.actions.length === 0 ? <p className="text-[12.5px] text-muted">Nothing urgent — this lead is on track.</p> : (
          <ul className="flex flex-col gap-2">
            {data.actions.map((a, i) => (
              <li key={i} className="flex gap-3 rounded-lg border border-border px-3 py-2.5">
                <Lightbulb className="mt-0.5 size-4 shrink-0 text-accent" />
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2 text-[13px] font-medium">{a.title}<span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-medium', URGENCY[a.urgency])}>{a.urgency === 'now' ? 'Now' : a.urgency === 'today' ? 'Today' : 'Soon'}</span></div><p className="mt-0.5 text-[12px] text-muted">{a.why}</p></div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          {([['intro', 'Draft intro email'], ['followup', 'Draft follow-up'], ['whatsapp', 'Draft WhatsApp']] as const).map(([k, l]) => (
            <Button key={k} size="sm" variant="outline" loading={busy === k} onClick={() => write(k)}><Sparkles className="text-accent" /> {l}</Button>
          ))}
        </div>
        {draft && (
          <div className="rounded-lg border border-accent/30 bg-accent-dim/50 p-3">
            <div className="mb-2 flex items-center justify-between text-[11px] text-subtle"><span>{draft.engine === 'claude' ? 'Written by AI from the company profile' : 'Template — turn on AI in platform settings for personalised drafts'}</span><button type="button" onClick={copy} className="flex items-center gap-1 text-accent hover:underline"><Copy className="size-3" />Copy</button></div>
            {draft.subject && <div className="mb-1.5 text-[12.5px]"><span className="text-subtle">Subject: </span><b className="font-medium">{draft.subject}</b></div>}
            <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={Math.min(12, draft.body.split('\n').length + 1)} className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-[12.5px] leading-relaxed outline-none focus:border-fg/40" aria-label="Draft" />
            <p className="mt-1.5 flex items-center gap-1 text-[11px] text-subtle"><Check className="size-3" />Edit freely, then copy into your email or WhatsApp. <Phone className="ml-1 size-3" />Contact details are never sent to the AI.</p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
