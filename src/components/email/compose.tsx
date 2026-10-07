'use client';
import { ArrowLeft, CalendarClock, Info, Send, Users } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { EmptyState, InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { PRESETS } from '@/lib/email/presets';
import type { EmailDesign } from '@/lib/email/types';
import { fmtInt } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { EmailEditor, type EmailDoc, type Sender } from './editor';

export const AUDIENCE_KEY = 'lcrm.email.audience';
type Stored = { audience: Record<string, unknown>; label: string; count: number };
type Preview = { total: number; sendable: number; skipped: Record<string, number>; sample: Record<string, string> | null };

/** Builds and queues a campaign. The audience comes from a lead-list selection (session storage) or ?lead= for a direct email. */
export function ComposePage({ base, workspace }: { base: string; workspace: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const senders = useApiQuery<{ accounts: Sender[] }>('/api/v1/email/smtp');
  const templates = useApiQuery<{ templates: { id: string; name: string; subject: string; preheader: string | null; design: EmailDesign }[] }>('/api/v1/email/templates');
  const [stored, setStored] = useState<Stored | null>(null);
  const [doc, setDoc] = useState<EmailDoc | null>(null);
  const [name, setName] = useState('');
  const [sender, setSender] = useState('');
  const [trackOpens, setTrackOpens] = useState(true);
  const [schedule, setSchedule] = useState(false);
  const [when, setWhen] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    const lead = sp.get('lead');
    if (lead) {
      setStored({ audience: workspace ? { kind: 'workspace', ids: [lead] } : { kind: 'platform', selection: { mode: 'ids', ids: [lead] } }, label: sp.get('name') ? `Direct email to ${sp.get('name')}` : 'Direct email', count: 1 });
      return;
    }
    try {
      const raw = sessionStorage.getItem(AUDIENCE_KEY);
      if (raw) setStored(JSON.parse(raw));
    } catch {}
  }, [sp, workspace]);

  useEffect(() => {
    if (doc || !templates.data) return;
    const t = templates.data.templates.find((x) => x.id === sp.get('template'));
    if (t) { setDoc({ subject: t.subject, preheader: t.preheader ?? '', design: t.design }); return; }
    const p = PRESETS[0];
    setDoc({ subject: p.subject, preheader: p.preheader, design: p.design() });
  }, [templates.data, doc, sp]);

  useEffect(() => {
    const def = senders.data?.accounts.find((a) => a.isDefault) ?? senders.data?.accounts[0];
    if (def && !sender) setSender(def.id);
  }, [senders.data, sender]);

  useEffect(() => {
    if (!stored) return;
    setName((n) => n || `${stored.label} · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`);
    api<Preview>('/api/v1/email/audience', { body: { audience: stored.audience } }).then(setPreview).catch((e) => setPreviewErr(errorMessage(e)));
  }, [stored]);

  const chosen = useMemo(() => senders.data?.accounts.find((a) => a.id === sender), [senders.data, sender]);

  if (!stored) {
    return (
      <>
        <PageHeader title="New campaign" />
        <Card><EmptyState icon={Users} title="Choose recipients first" description="Select leads in the leads list (or filter them) and choose “Email” to start a campaign." action={<Button variant="primary" size="sm" onClick={() => router.push(`${base}/leads`)}>Go to leads</Button>} /></Card>
      </>
    );
  }
  if (!doc || senders.isLoading) return <Skeleton className="h-[720px]" />;
  const large = (preview?.sendable ?? 0) >= 200;

  const send = async () => {
    const res = await api<{ id: string }>('/api/v1/email/campaigns', {
      body: { name, smtpAccountId: sender, templateId: sp.get('template') || null, subject: doc.subject, preheader: doc.preheader || null, design: doc.design, audience: stored.audience, trackOpens, scheduledFor: schedule && when ? new Date(when).toISOString() : null, confirmLarge: true },
    });
    sessionStorage.removeItem(AUDIENCE_KEY);
    router.push(`${base}/email/campaigns/${res.id}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={() => router.back()}><ArrowLeft /> Back</Button>
          <h1 className="text-[22px] leading-tight font-[560] tracking-[-0.028em]">New email campaign</h1>
        </div>
        <Button variant="primary" size="lg" disabled={!preview?.sendable || !sender || !doc.subject.trim() || (schedule && !when)} onClick={() => setConfirm(true)}>
          {schedule ? <><CalendarClock /> Schedule</> : <><Send /> Send to {fmtInt(preview?.sendable ?? 0)}</>}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.2fr_1fr_1fr]">
        <Card><CardBody className="flex flex-col gap-2">
          <div className="eyebrow flex items-center gap-1.5"><Users className="size-3" />Recipients</div>
          <div className="text-[13px] text-fg">{stored.label}</div>
          {previewErr ? <InlineNotice tone="danger">{previewErr}</InlineNotice> : !preview ? <Skeleton className="h-10" /> : (
            <>
              <div className="flex items-baseline gap-2"><span className="tnum text-2xl tracking-tight">{fmtInt(preview.sendable)}</span><span className="text-[12px] text-subtle">will receive it · {fmtInt(preview.total)} selected</span></div>
              {Object.entries(preview.skipped).length > 0 && <div className="flex flex-wrap gap-1">{Object.entries(preview.skipped).map(([r, n]) => <Badge key={r} tone="outline">{r}: {n}</Badge>)}</div>}
              {preview.sample && <div className="text-[11px] text-subtle">First recipient: {preview.sample.fullName} · {preview.sample.email}</div>}
            </>
          )}
        </CardBody></Card>
        <Card><CardBody className="flex flex-col gap-3">
          <Field label="Campaign name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          {senders.data?.accounts.length ? (
            <Field label="Send from">
              <Select value={sender} onChange={(e) => setSender(e.target.value)}>{senders.data.accounts.map((a) => <option key={a.id} value={a.id}>{a.fromName} &lt;{a.fromEmail}&gt;{a.status !== 'VERIFIED' ? ' · unverified' : ''}</option>)}</Select>
            </Field>
          ) : <InlineNotice tone="warn">No SMTP sender yet. Add one in Email → Senders.</InlineNotice>}
          {chosen && chosen.status !== 'VERIFIED' && <p className="text-[11px] text-warn">This sender hasn’t been verified. Verify it in Senders to avoid failed sends.</p>}
        </CardBody></Card>
        <Card><CardBody className="flex flex-col gap-3 text-[12.5px]">
          <Field label="Start from a template">
            <Select value="" onChange={(e) => { const t = templates.data?.templates.find((x) => x.id === e.target.value) ?? null; const p = PRESETS.find((x) => `preset:${x.key}` === e.target.value); if (t) setDoc({ subject: t.subject, preheader: t.preheader ?? '', design: t.design }); else if (p) setDoc({ subject: p.subject, preheader: p.preheader, design: p.design() }); }}>
              <option value="">Replace content with…</option>
              {templates.data?.templates.length ? <optgroup label="Saved templates">{templates.data.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup> : null}
              <optgroup label="Designs">{PRESETS.map((p) => <option key={p.key} value={`preset:${p.key}`}>{p.name}</option>)}</optgroup>
            </Select>
          </Field>
          <label className="flex items-center justify-between">Track opens<Switch checked={trackOpens} onCheckedChange={setTrackOpens} /></label>
          <label className="flex items-center justify-between">Schedule for later<Switch checked={schedule} onCheckedChange={setSchedule} /></label>
          {schedule && <Input type="datetime-local" value={when} min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)} onChange={(e) => setWhen(e.target.value)} />}
        </CardBody></Card>
      </div>
      <EmailEditor value={doc} onChange={setDoc} senders={senders.data?.accounts ?? []} />
      <p className="flex items-center gap-1.5 text-[11px] text-subtle"><Info className="size-3" />Recipients who unsubscribed{workspace ? ', opted out of email,' : ''} or have no valid address are skipped automatically. Each email is personalised and logged individually.</p>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={schedule ? 'Schedule campaign' : 'Send campaign'} confirmLabel={schedule ? 'Schedule' : 'Send now'}
        typed={large ? `SEND ${preview?.sendable}` : undefined}
        description={`${fmtInt(preview?.sendable ?? 0)} personalised emails will be sent from ${chosen?.fromEmail ?? 'the selected sender'}${schedule ? ` at ${when.replace('T', ' ')}` : ''}, throttled to ${chosen ? `${chosen.perMinuteLimit}/min` : 'the sender’s limit'}.`}
        onConfirm={send} />
    </div>
  );
}
