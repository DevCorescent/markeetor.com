'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, Check, FileInput, Library, MessageCircle, MessageSquareText, Plus, Radio, Save, ShieldAlert, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CaptureFormView } from '@/components/marketing/capture-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, Switch, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { Kpi, KpiGrid, PageHeader } from '@/components/ui/page';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtInt } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';
import { MARKETING_FEATURES, type FormConfig, type MarketingFeature, type MarketingSettings, type SequenceStep } from '@/lib/marketing';

type Env = { whatsapp: boolean; whatsappWebhook: boolean; sms: boolean; ai: boolean };
type AdminOverview = {
  days: number; total: number; failed: number; deliveryRate: number | null; creditsEarned: number;
  channels: { channel: string; status: string; count: number }[];
  clients: { organizationId: string; name: string; messages: number; credits: number }[];
  activeSequences: number; forms: number; submissions: number; links: number; clicks: number;
  review: {
    forms: { id: string; name: string; slug: string; organization: string; config: FormConfig; createdAt: string }[];
    broadcasts: { id: string; name: string; channel: string; body: string; total: number; organization: string; createdAt: string }[];
  };
};
const invalidate = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/admin/marketing') });

// ── Overview ───────────────────────────────────────────────────────

function OverviewTab() {
  const [days, setDays] = useState(30);
  const { data } = useApiQuery<AdminOverview>(`/api/v1/admin/marketing/overview?days=${days}`);
  if (!data) return <Skeleton className="h-80" />;
  const ch = (c: string) => data.channels.filter((r) => r.channel === c);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end"><Select className="h-8 w-36" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">{[7, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}</Select></div>
      <KpiGrid>
        <Kpi label="Messages" value={fmtInt(data.total)} sub={`${fmtInt(data.failed)} failed`} />
        <Kpi label="Delivery rate" value={data.deliveryRate == null ? '—' : `${data.deliveryRate}%`} sub="not failed" />
        <Kpi label="Credits earned" value={fmtInt(data.creditsEarned)} sub="from WhatsApp / SMS" />
        <Kpi label="Active sequences" value={fmtInt(data.activeSequences)} sub={`${fmtInt(data.forms)} forms · ${fmtInt(data.submissions)} form leads`} />
      </KpiGrid>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1.4fr]">
        <Card className="self-start">
          <CardHeader title="By channel" />
          <CardBody className="flex flex-col gap-3">
            {(['WHATSAPP', 'SMS'] as const).map((c) => {
              const rows = ch(c); const total = rows.reduce((a, r) => a + r.count, 0);
              return (
                <div key={c}>
                  <div className="mb-1 flex items-center gap-2 text-[12.5px]">{c === 'WHATSAPP' ? <MessageCircle className="size-3.5 text-ok" /> : <MessageSquareText className="size-3.5 text-accent" />}<span className="font-medium">{c === 'WHATSAPP' ? 'WhatsApp' : 'SMS'}</span><span className="tnum ml-auto">{fmtInt(total)}</span></div>
                  <div className="flex flex-wrap gap-1">{rows.map((r) => <Badge key={r.status} tone={r.status === 'FAILED' ? 'danger' : r.status === 'SKIPPED' ? 'warn' : r.status === 'LOGGED' ? 'neutral' : 'ok'}>{r.status.toLowerCase()} {fmtInt(r.count)}</Badge>)}{!rows.length && <span className="text-[11.5px] text-subtle">No messages</span>}</div>
                </div>
              );
            })}
            <div className="flex justify-between border-t border-border pt-2 text-[12.5px]"><span className="text-muted">Tracked links</span><span className="tnum">{fmtInt(data.links)} links · {fmtInt(data.clicks)} clicks</span></div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Top clients by messages" />
          <div className="overflow-x-auto"><table className="w-full text-[12.5px]">
            <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase"><th className="h-9 px-4 font-medium">Client</th><th className="px-4 font-medium">Messages</th><th className="px-4 font-medium">Credits</th></tr></thead>
            <tbody>{data.clients.map((c) => <tr key={c.organizationId} className="border-b border-border/60 last:border-0"><td className="px-4 py-2 font-medium"><a className="hover:underline" href={`/admin/organizations/${c.organizationId}`}>{c.name}</a></td><td className="tnum px-4">{fmtInt(c.messages)}</td><td className="tnum px-4">{fmtInt(c.credits)}</td></tr>)}
              {!data.clients.length && <tr><td colSpan={3} className="py-8 text-center text-subtle">No client messages in this period.</td></tr>}</tbody>
          </table></div>
        </Card>
      </div>
    </div>
  );
}

// ── Controls ───────────────────────────────────────────────────────

function NumberField({ label, value, onChange, hint, min = 0 }: { label: string; value: number; onChange: (n: number) => void; hint?: string; min?: number }) {
  return <Field label={label} hint={hint}><Input type="number" min={min} value={value} onChange={(e) => onChange(Math.max(min, Number(e.target.value) || 0))} /></Field>;
}

function ControlsTab() {
  const { data } = useApiQuery<{ settings: MarketingSettings; env: Env }>('/api/v1/admin/marketing/settings');
  if (!data) return <Skeleton className="h-96" />;
  return <ControlsForm key={JSON.stringify(data.settings)} data={data} />;
}

function ControlsForm({ data }: { data: { settings: MarketingSettings; env: Env } }) {
  const qc = useQueryClient();
  const orgs = useApiQuery<{ rows: { id: string; name: string }[] }>('/api/v1/organizations?pageSize=200');
  const [s, setS] = useState<MarketingSettings>(data.settings);
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState(data.settings.moderation.blockedWords.join(', '));
  const [addOrg, setAddOrg] = useState('');
  const env = data.env;
  const dirty = JSON.stringify(s) !== JSON.stringify(data.settings) || words !== data.settings.moderation.blockedWords.join(', ');
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...s, moderation: { ...s.moderation, blockedWords: [...new Set(words.split(',').map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2))] } };
      await api('/api/v1/admin/marketing/settings', { method: 'PUT', body }); toast.success('Marketing controls saved'); await invalidate(qc);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const orgName = (id: string) => orgs.data?.rows.find((o) => o.id === id)?.name ?? id;
  const setOv = (i: number, p: Partial<MarketingSettings['overrides'][number]>) => setS({ ...s, overrides: s.overrides.map((o, j) => (j === i ? { ...o, ...p } : o)) });
  const envPill = (ok: boolean, label: string) => <span className={cn('rounded-full px-2 py-0.5 text-[10.5px]', ok ? 'bg-ok-dim text-ok' : 'bg-surface-3 text-subtle')}>{label}: {ok ? 'configured' : 'not set'}</span>;
  return (
    <div className="flex flex-col gap-4 pb-16">
      <Card>
        <CardHeader title="Marketing tools" description="Master switch and the tools each client workspace gets" actions={<label className="flex items-center gap-2 text-[12.5px]">{s.enabled ? 'On' : 'Off for everyone'}<Switch checked={s.enabled} onCheckedChange={(v) => setS({ ...s, enabled: v })} aria-label="Marketing enabled" /></label>} />
        <CardBody className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {MARKETING_FEATURES.map((f) => (
            <label key={f.key} className={cn('flex items-start justify-between gap-3 rounded-lg border border-border p-3', !s.enabled && 'opacity-50')}>
              <span><span className="block text-[12.5px] font-medium">{f.label}</span><span className="block text-[11px] text-subtle">{f.hint}</span></span>
              <Switch checked={s.features[f.key]} disabled={!s.enabled} onCheckedChange={(v) => setS({ ...s, features: { ...s.features, [f.key]: v } })} aria-label={f.label} />
            </label>
          ))}
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Delivery providers" description="Credentials live in the server environment, never in the database" />
          <CardBody className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="WhatsApp"><Select value={s.providers.whatsapp} onChange={(e) => setS({ ...s, providers: { ...s.providers, whatsapp: e.target.value as MarketingSettings['providers']['whatsapp'] } })}><option value="off">Off</option><option value="log">Test mode (log only)</option><option value="cloud">WhatsApp Cloud API</option></Select></Field>
              <Field label="SMS"><Select value={s.providers.sms} onChange={(e) => setS({ ...s, providers: { ...s.providers, sms: e.target.value as MarketingSettings['providers']['sms'] } })}><option value="off">Off</option><option value="log">Test mode (log only)</option><option value="twilio">Twilio</option></Select></Field>
            </div>
            <div className="flex flex-wrap gap-1.5">{envPill(env.whatsapp, 'WhatsApp token')}{envPill(env.whatsappWebhook, 'WhatsApp webhook')}{envPill(env.sms, 'Twilio')}{envPill(env.ai, 'AI writer key')}</div>
            {s.providers.whatsapp === 'cloud' && !env.whatsapp && <InlineNotice tone="warn">Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID — until then WhatsApp sends are blocked.</InlineNotice>}
            {s.providers.sms === 'twilio' && !env.sms && <InlineNotice tone="warn">Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM — until then SMS sends are blocked.</InlineNotice>}
            <p className="text-[11px] text-subtle">WhatsApp webhook URL: <code className="rounded bg-surface-2 px-1">/api/v1/public/whatsapp/webhook</code> — delivery receipts, replies (stop sequences) and STOP opt-outs.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Pricing (credits)" description="Charged from the client’s credit wallet; 0 = free" />
          <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <NumberField label="Per WhatsApp" value={s.pricing.whatsapp} onChange={(n) => setS({ ...s, pricing: { ...s.pricing, whatsapp: n } })} />
            <NumberField label="Per SMS" value={s.pricing.sms} onChange={(n) => setS({ ...s, pricing: { ...s.pricing, sms: n } })} />
            <NumberField label="Per AI draft" value={s.pricing.aiDraft} onChange={(n) => setS({ ...s, pricing: { ...s.pricing, aiDraft: n } })} />
            <p className="text-[11px] text-subtle sm:col-span-3">Failed sends are refunded automatically. Template (non-AI) drafts are always free.</p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Limits per workspace" description="0 = unlimited for daily caps" />
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3 xl:grid-cols-7">
          {([['messagesPerDay', 'Messages / day'], ['aiDraftsPerDay', 'AI drafts / day'], ['sequences', 'Sequences'], ['stepsPerSequence', 'Steps / sequence'], ['segments', 'Segments'], ['forms', 'Forms'], ['links', 'Links']] as const).map(([k, l]) => (
            <NumberField key={k} label={l} min={k === 'stepsPerSequence' ? 1 : 0} value={s.limits[k]} onChange={(n) => setS({ ...s, limits: { ...s.limits, [k]: n } })} />
          ))}
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Quiet hours" description="No automated WhatsApp / SMS at night — sends wait until morning" actions={<Switch checked={s.quietHours.enabled} onCheckedChange={(v) => setS({ ...s, quietHours: { ...s.quietHours, enabled: v } })} aria-label="Quiet hours" />} />
          <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="From"><Select value={s.quietHours.start} disabled={!s.quietHours.enabled} onChange={(e) => setS({ ...s, quietHours: { ...s.quietHours, start: Number(e.target.value) } })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</Select></Field>
            <Field label="Until"><Select value={s.quietHours.end} disabled={!s.quietHours.enabled} onChange={(e) => setS({ ...s, quietHours: { ...s.quietHours, end: Number(e.target.value) } })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</Select></Field>
            <Field label="Time zone"><Select value={s.quietHours.timezone} disabled={!s.quietHours.enabled} onChange={(e) => setS({ ...s, quietHours: { ...s.quietHours, timezone: e.target.value } })}>{['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'].map((z) => <option key={z}>{z}</option>)}</Select></Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Moderation" description="Keep client marketing compliant" />
          <CardBody className="flex flex-col gap-3">
            <label className="flex items-center justify-between gap-2 text-[12.5px]">Review new lead forms before they go live<Switch checked={s.moderation.reviewForms} onCheckedChange={(v) => setS({ ...s, moderation: { ...s.moderation, reviewForms: v } })} aria-label="Review forms" /></label>
            <NumberField label="Hold broadcasts larger than (recipients)" hint="0 = never hold" value={s.moderation.reviewBroadcastsAbove} onChange={(n) => setS({ ...s, moderation: { ...s.moderation, reviewBroadcastsAbove: n } })} />
            <Field label="Blocked words" hint="Comma separated — messages, sequences, forms and links containing them are refused"><Textarea rows={2} value={words} onChange={(e) => setWords(e.target.value)} placeholder="e.g. guaranteed returns, lottery" /></Field>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Per-client overrides" description="Switch tools on or off and set a daily message cap for specific clients" />
        <CardBody className="flex flex-col gap-3">
          {s.overrides.map((o, i) => (
            <div key={o.organizationId} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center gap-2"><span className="font-medium">{orgName(o.organizationId)}</span><div className="ml-auto flex items-center gap-2 text-[12px] text-muted">Messages/day<Input type="number" min={0} className="h-7 w-24" placeholder="default" value={o.messagesPerDay ?? ''} onChange={(e) => setOv(i, { messagesPerDay: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} /></div><Button size="xs" variant="ghost" aria-label="Remove override" onClick={() => setS({ ...s, overrides: s.overrides.filter((_, j) => j !== i) })}><X /></Button></div>
              <div className="flex flex-wrap gap-1.5">
                {MARKETING_FEATURES.map((f) => {
                  const v = o.features[f.key as MarketingFeature];
                  const next = v === undefined ? !s.features[f.key] : undefined;
                  return <button key={f.key} type="button" onClick={() => { const fs = { ...o.features }; if (next === undefined) delete fs[f.key]; else fs[f.key] = next; setOv(i, { features: fs }); }} className={cn('rounded-full border px-2 py-0.5 text-[11px]', v === undefined ? 'border-border text-subtle' : v ? 'border-ok/40 bg-ok-dim text-ok' : 'border-danger/40 bg-danger-dim text-danger')} title="Click to cycle: default → override → default">{f.label}{v === undefined ? ' · default' : v ? ' · on' : ' · off'}</button>;
                })}
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <Select className="h-8 max-w-xs" value={addOrg} onChange={(e) => setAddOrg(e.target.value)} aria-label="Client"><option value="">Choose a client…</option>{(orgs.data?.rows ?? []).filter((o) => !s.overrides.some((x) => x.organizationId === o.id)).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
            <Button size="sm" disabled={!addOrg} onClick={() => { setS({ ...s, overrides: [...s.overrides, { organizationId: addOrg, features: {}, messagesPerDay: null }] }); setAddOrg(''); }}><Plus /> Add override</Button>
          </div>
        </CardBody>
      </Card>

      {dirty && (
        <div className="fixed inset-x-0 bottom-4 z-30 mx-auto flex w-fit items-center gap-3 rounded-full border border-border bg-surface px-4 py-2 shadow-lg">
          <span className="text-[12.5px] text-muted">Unsaved changes</span>
          <Button size="sm" variant="ghost" onClick={() => { setS(data.settings); setWords(data.settings.moderation.blockedWords.join(', ')); }}>Discard</Button>
          <Button size="sm" variant="primary" loading={busy} onClick={save}><Save /> Save controls</Button>
        </div>
      )}
    </div>
  );
}

// ── Moderation ─────────────────────────────────────────────────────

function ModerationTab() {
  const qc = useQueryClient();
  const { data } = useApiQuery<AdminOverview>('/api/v1/admin/marketing/overview?days=30');
  const [peek, setPeek] = useState<AdminOverview['review']['forms'][number] | null>(null);
  const decide = async (kind: 'forms' | 'broadcasts', id: string, action: 'approve' | 'reject') => {
    const note = action === 'reject' ? window.prompt('Reason shown to the client (optional)') ?? undefined : undefined;
    try { await api(`/api/v1/admin/marketing/review/${kind}/${id}`, { body: { action, note: note || undefined } }); toast.success(action === 'approve' ? 'Approved' : 'Rejected'); await invalidate(qc); } catch (e) { toast.error(errorMessage(e)); }
  };
  if (!data) return <Skeleton className="h-60" />;
  const { forms, broadcasts } = data.review;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Broadcasts waiting" description="Large sends held for approval" />
        <ul className="flex flex-col divide-y divide-border">
          {broadcasts.map((b) => (
            <li key={b.id} className="flex flex-col gap-2 px-4 py-3 text-[12.5px]">
              <div className="flex items-center gap-2"><Radio className="size-3.5 text-accent" /><span className="font-medium">{b.name}</span><Badge>{b.channel === 'WHATSAPP' ? 'WhatsApp' : 'SMS'}</Badge><span className="text-subtle">{b.organization} · {fmtInt(b.total)} recipients · {fmtAgo(b.createdAt)}</span></div>
              <p className="rounded-md bg-surface-2 px-2.5 py-2 whitespace-pre-wrap">{b.body}</p>
              <div className="flex gap-2"><Button size="sm" variant="primary" onClick={() => decide('broadcasts', b.id, 'approve')}><Check /> Approve & send</Button><Button size="sm" variant="danger" onClick={() => decide('broadcasts', b.id, 'reject')}><Ban /> Reject</Button></div>
            </li>
          ))}
          {!broadcasts.length && <li className="py-10 text-center text-[12.5px] text-subtle">Nothing waiting.</li>}
        </ul>
      </Card>
      <Card>
        <CardHeader title="Lead forms waiting" description="New forms held for review" />
        <ul className="flex flex-col divide-y divide-border">
          {forms.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-[12.5px]">
              <FileInput className="size-3.5 text-info" /><span className="font-medium">{f.name}</span><span className="text-subtle">{f.organization} · {fmtAgo(f.createdAt)}</span>
              <span className="ml-auto flex gap-1.5"><Button size="xs" onClick={() => setPeek(f)}>Preview</Button><Button size="xs" variant="primary" onClick={() => decide('forms', f.id, 'approve')}><Check /> Approve</Button><Button size="xs" variant="danger" onClick={() => decide('forms', f.id, 'reject')}><Ban /></Button></span>
            </li>
          ))}
          {!forms.length && <li className="py-10 text-center text-[12.5px] text-subtle">Nothing waiting.</li>}
        </ul>
      </Card>
      {peek && <Dialog open onOpenChange={(o) => !o && setPeek(null)} title={`${peek.name} — ${peek.organization}`}><div className="rounded-xl bg-[#f4f4f5] p-3"><CaptureFormView form={{ slug: peek.slug, name: peek.name, organization: peek.organization, config: peek.config }} embed preview /></div></Dialog>}
    </div>
  );
}

// ── Library ────────────────────────────────────────────────────────

type Tpl = { id: string; kind: 'SEQUENCE' | 'WHATSAPP' | 'SMS'; name: string; description: string | null; content: unknown; published: boolean; updatedAt: string };
type TplDraft = { id: string | null; kind: Tpl['kind']; name: string; description: string; body: string; steps: SequenceStep[]; published: boolean };
const blankStep = (type: SequenceStep['type'], delayHours = 24): SequenceStep => ({ id: `s${Math.random().toString(36).slice(2, 8)}`, type, delayHours, body: type === 'task' ? null : 'Hi {first_name|there}, ', title: type === 'task' ? 'Call {first_name}' : null, templateId: null });

function LibraryTab() {
  const qc = useQueryClient();
  const { data } = useApiQuery<{ rows: Tpl[] }>('/api/v1/admin/marketing/templates');
  const [d, setD] = useState<TplDraft | null>(null);
  const open = (t?: Tpl) => {
    if (!t) return setD({ id: null, kind: 'SEQUENCE', name: '', description: '', body: '', steps: [blankStep('whatsapp', 0), blankStep('task', 48)], published: true });
    const c = (t.content ?? {}) as { body?: string; steps?: SequenceStep[] };
    setD({ id: t.id, kind: t.kind, name: t.name, description: t.description ?? '', body: c.body ?? '', steps: c.steps ?? [], published: t.published });
  };
  const save = async () => {
    if (!d) return;
    const content = d.kind === 'SEQUENCE' ? { name: d.name, steps: d.steps, stopOnReply: true, stopOnStatus: ['CONVERTED', 'LOST'], segmentId: null, autoEnroll: false } : { body: d.body };
    try { await api(d.id ? `/api/v1/admin/marketing/templates/${d.id}` : '/api/v1/admin/marketing/templates', { method: d.id ? 'PUT' : 'POST', body: { kind: d.kind, name: d.name, description: d.description || null, content, published: d.published } }); toast.success('Template saved'); setD(null); await invalidate(qc); } catch (e) { toast.error(errorMessage(e)); }
  };
  const setStep = (i: number, p: Partial<SequenceStep>) => d && setD({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between"><p className="text-[12px] text-subtle">Published templates appear to every client as “Start from a template”. Sequence templates use WhatsApp, SMS and task steps (email steps need the client’s own templates).</p><Button variant="primary" onClick={() => open()}><Plus /> New template</Button></div>
      {!data ? <Skeleton className="h-40" /> : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.rows.map((t) => (
            <Card key={t.id} className="flex flex-col gap-2 p-4">
              <div className="flex items-center gap-2"><Badge tone={t.kind === 'SEQUENCE' ? 'solid' : t.kind === 'WHATSAPP' ? 'ok' : 'neutral'}>{t.kind.toLowerCase()}</Badge><span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>{!t.published && <Badge tone="warn">draft</Badge>}</div>
              {t.description && <p className="text-[11.5px] text-subtle">{t.description}</p>}
              <div className="flex gap-1.5 pt-1"><Button size="xs" variant="ghost" onClick={() => open(t)}>Edit</Button><Button size="xs" variant="ghost" aria-label="Delete" onClick={async () => { await api(`/api/v1/admin/marketing/templates/${t.id}`, { method: 'DELETE' }); await invalidate(qc); }}><Trash2 /></Button></div>
            </Card>
          ))}
          {!data.rows.length && <Card className="py-10 text-center text-[12.5px] text-subtle md:col-span-3">No templates yet.</Card>}
        </div>
      )}
      {d && (
        <Dialog open onOpenChange={(o) => !o && setD(null)} title={d.id ? 'Edit template' : 'New template'} size="lg" footer={<><Button variant="ghost" onClick={() => setD(null)}>Cancel</Button><Button variant="primary" disabled={d.name.trim().length < 2 || (d.kind === 'SEQUENCE' ? !d.steps.length : !d.body.trim())} onClick={save}>Save</Button></>}>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Type"><Select value={d.kind} disabled={!!d.id} onChange={(e) => setD({ ...d, kind: e.target.value as Tpl['kind'] })}><option value="SEQUENCE">Sequence</option><option value="WHATSAPP">WhatsApp message</option><option value="SMS">SMS message</option></Select></Field>
              <Field label="Name" className="sm:col-span-2"><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
            </div>
            <Field label="Description"><Input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} placeholder="When to use it" /></Field>
            {d.kind === 'SEQUENCE' ? (
              <div className="flex flex-col gap-2">
                {d.steps.map((st, i) => (
                  <div key={st.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
                    <div className="flex items-center gap-2 text-[12px]"><span className="tnum font-semibold">{i + 1}</span><Select className="h-7 w-32" value={st.type} onChange={(e) => setStep(i, { ...blankStep(e.target.value as SequenceStep['type'], st.delayHours), id: st.id })}><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="task">Task</option></Select>after<Input type="number" min={0} className="h-7 w-20" value={st.delayHours} onChange={(e) => setStep(i, { delayHours: Math.max(0, Number(e.target.value) || 0) })} />hours<Button size="xs" variant="ghost" className="ml-auto" onClick={() => setD({ ...d, steps: d.steps.filter((_, j) => j !== i) })} aria-label="Remove"><X /></Button></div>
                    {st.type === 'task' ? <Input className="h-8" value={st.title ?? ''} onChange={(e) => setStep(i, { title: e.target.value })} /> : <Textarea rows={2} value={st.body ?? ''} onChange={(e) => setStep(i, { body: e.target.value })} />}
                  </div>
                ))}
                <Button size="sm" variant="outline" className="self-start" onClick={() => setD({ ...d, steps: [...d.steps, blankStep('whatsapp')] })}><Plus /> Add step</Button>
              </div>
            ) : <Field label="Message"><Textarea rows={5} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} /></Field>}
            <label className="flex items-center justify-between text-[12.5px]">Published to clients<Switch checked={d.published} onCheckedChange={(v) => setD({ ...d, published: v })} aria-label="Published" /></label>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────

export function MarketingAdmin() {
  const [s, set] = useUrlState({ tab: 'overview' });
  const pending = useApiQuery<AdminOverview>('/api/v1/admin/marketing/overview?days=30');
  const waiting = (pending.data?.review.forms.length ?? 0) + (pending.data?.review.broadcasts.length ?? 0);
  const tabs = [
    { key: 'overview', label: 'Overview', icon: MessageCircle },
    { key: 'controls', label: 'Controls', icon: SlidersHorizontal },
    { key: 'moderation', label: waiting ? `Moderation (${waiting})` : 'Moderation', icon: ShieldAlert },
    { key: 'library', label: 'Template library', icon: Library },
  ];
  return (
    <>
      <PageHeader eyebrow="Lead operations" title="Marketing" description="Control the marketing tools every client gets — features, pricing, limits, quiet hours, providers, moderation and shared templates." />
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}>
        <TabsList className="mb-4 overflow-x-auto">{tabs.map((t) => <TabsTrigger key={t.key} value={t.key}><span className="inline-flex items-center gap-1.5"><t.icon className="size-3.5" />{t.label}</span></TabsTrigger>)}</TabsList>
      </Tabs>
      {s.tab === 'overview' && <OverviewTab />}
      {s.tab === 'controls' && <ControlsTab />}
      {s.tab === 'moderation' && <ModerationTab />}
      {s.tab === 'library' && <LibraryTab />}
    </>
  );
}
