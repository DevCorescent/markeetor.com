'use client';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, BarChart3, Bot, FileInput, Link2, ListChecks, Mail, MessageCircle, MessageSquareText, Pause, Play, Plus, QrCode, Radio, Send, Sparkles, Trash2, Users, Workflow, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FilterBuilder } from '@/components/data/filter-builder';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, Switch, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { clientLeadFields, type ClientFacets } from '@/app/app/leads/client-leads';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import type { Condition } from '@/lib/filters';
import { fmtAgo, fmtInt } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';
import { MERGE_TAGS, type MarketingFeature, type SequenceStep } from '@/lib/marketing';
import { FormsTab, LinksTab, WriterTab } from './marketing-tools';

export type Overview = {
  days: number; features: Record<MarketingFeature, boolean>; pricing: { whatsapp: number; sms: number; aiDraft: number };
  providers: Record<'whatsapp' | 'sms', { ok: boolean; mode: string; live: boolean }>; quietHours: { enabled: boolean; start: number; end: number; timezone: string };
  channels: Record<'whatsapp' | 'sms' | 'email', Record<string, number>>; creditsSpent: number; clicks: number; submissions: number;
  sequences: { id: string; name: string; status: string; enrolledCount: number; active: number; completed: number; replied: number; converted: number; stopped: number }[];
  topLinks: { id: string; name: string; code: string; clicks: number; uniqueLeads: number }[];
  forms: { id: string; name: string; views: number; submissions: number; status: string }[];
};
type Segment = { id: string; name: string; filter: { conditions: Condition[] }; size: number; createdAt: string };

export const invalidateMarketing = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/marketing') });
const sum = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);
const STEP_META = {
  email: { icon: Mail, label: 'Email', tone: 'bg-info-dim text-info' },
  whatsapp: { icon: MessageCircle, label: 'WhatsApp', tone: 'bg-ok-dim text-ok' },
  sms: { icon: MessageSquareText, label: 'SMS', tone: 'bg-accent-dim text-accent' },
  task: { icon: ListChecks, label: 'Task', tone: 'bg-warn-dim text-warn' },
} as const;

// ── Overview ───────────────────────────────────────────────────────

function OverviewTab({ o, go }: { o: Overview; go: (tab: string) => void }) {
  const tile = (icon: React.ComponentType<{ className?: string }>, tone: string, label: string, value: React.ReactNode, sub: string, tab?: string) => {
    const I = icon;
    return (
      <button type="button" onClick={() => tab && go(tab)} className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3.5 text-left hover:border-border-strong">
        <div className="flex items-center justify-between"><span className="eyebrow">{label}</span><span className={cn('grid size-7 place-items-center rounded-md', tone)}><I className="size-3.5" /></span></div>
        <div className="tnum text-[24px] leading-none font-semibold tracking-[-0.03em]">{value}</div>
        <div className="text-[11.5px] text-subtle">{sub}</div>
      </button>
    );
  };
  const ch = (k: 'whatsapp' | 'sms') => o.channels[k];
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tile(MessageCircle, 'bg-ok-dim text-ok', 'WhatsApp sent', fmtInt((ch('whatsapp').SENT ?? 0) + (ch('whatsapp').DELIVERED ?? 0) + (ch('whatsapp').READ ?? 0) + (ch('whatsapp').LOGGED ?? 0)), `${fmtInt(ch('whatsapp').READ ?? 0)} read · ${fmtInt(ch('whatsapp').FAILED ?? 0)} failed`, 'broadcasts')}
        {tile(MessageSquareText, 'bg-accent-dim text-accent', 'SMS sent', fmtInt(sum(ch('sms')) - (ch('sms').SKIPPED ?? 0) - (ch('sms').FAILED ?? 0)), `${fmtInt(ch('sms').FAILED ?? 0)} failed`, 'broadcasts')}
        {tile(Mail, 'bg-info-dim text-info', 'Emails', fmtInt(sum(o.channels.email)), `${fmtInt((o.channels.email.OPENED ?? 0) + (o.channels.email.CLICKED ?? 0))} opened`)}
        {tile(Sparkles, 'bg-warn-dim text-warn', 'Credits used', fmtInt(o.creditsSpent), `last ${o.days} days on messages`)}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {tile(Workflow, 'bg-info-dim text-info', 'In sequences now', fmtInt(o.sequences.reduce((a, s) => a + s.active, 0)), `${fmtInt(o.sequences.reduce((a, s) => a + s.replied, 0))} replied · ${fmtInt(o.sequences.reduce((a, s) => a + s.converted, 0))} converted`, 'sequences')}
        {tile(Link2, 'bg-accent-dim text-accent', 'Link clicks', fmtInt(o.clicks), `${o.topLinks.length} links tracked`, 'links')}
        {tile(FileInput, 'bg-ok-dim text-ok', 'Form leads', fmtInt(o.submissions), `${o.forms.length} forms`, 'forms')}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Sequence performance" />
          <div className="overflow-x-auto"><table className="w-full min-w-[480px] text-[12.5px]">
            <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">{['Sequence', 'Enrolled', 'Active', 'Replied', 'Converted', 'Completed'].map((h) => <th key={h} className="h-9 px-4 font-medium">{h}</th>)}</tr></thead>
            <tbody>{o.sequences.map((s) => <tr key={s.id} className="border-b border-border/60 last:border-0"><td className="px-4 py-2"><span className="font-medium">{s.name}</span> <StatusBadge status={s.status} /></td><td className="tnum px-4">{fmtInt(s.enrolledCount)}</td><td className="tnum px-4">{fmtInt(s.active)}</td><td className="tnum px-4 text-ok">{fmtInt(s.replied)}</td><td className="tnum px-4 font-medium text-ok">{fmtInt(s.converted)}</td><td className="tnum px-4 text-muted">{fmtInt(s.completed)}</td></tr>)}
              {!o.sequences.length && <tr><td colSpan={6} className="py-8 text-center text-subtle">No sequences yet.</td></tr>}</tbody>
          </table></div>
        </Card>
        <Card className="self-start">
          <CardHeader title="Delivery setup" description="Managed by the platform" />
          <CardBody className="flex flex-col gap-2 text-[12.5px]">
            {(['whatsapp', 'sms'] as const).map((k) => <div key={k} className="flex items-center justify-between"><span className="capitalize">{k === 'sms' ? 'SMS' : 'WhatsApp'}</span><span className={cn('rounded-full px-2 py-0.5 text-[11px]', o.providers[k].live ? 'bg-ok-dim text-ok' : o.providers[k].ok ? 'bg-warn-dim text-warn' : 'bg-surface-3 text-subtle')}>{o.providers[k].live ? 'Live' : o.providers[k].ok ? 'Test mode — logged, not delivered' : 'Not available'}</span></div>)}
            <div className="flex items-center justify-between"><span>Cost per message</span><span className="tnum text-muted">WhatsApp {o.pricing.whatsapp} · SMS {o.pricing.sms} credits</span></div>
            {o.quietHours.enabled && <div className="flex items-center justify-between"><span>Quiet hours</span><span className="text-muted">{o.quietHours.start}:00 – {o.quietHours.end}:00 (sends wait)</span></div>}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

// ── Segments ───────────────────────────────────────────────────────

function SegmentsTab() {
  const qc = useQueryClient();
  const { data } = useApiQuery<{ rows: Segment[] }>('/api/v1/marketing/segments');
  const facets = useApiQuery<ClientFacets>('/api/v1/crm/leads/facets');
  const [edit, setEdit] = useState<{ id: string | null; name: string; conditions: Condition[] } | null>(null);
  const [preview, setPreview] = useState<{ total: number; withPhone: number; withEmail: number } | null>(null);
  useEffect(() => {
    if (!edit) return;
    const t = setTimeout(() => { api<{ total: number; withPhone: number; withEmail: number }>('/api/v1/marketing/segments/preview', { body: { filter: { conditions: edit.conditions } } }).then(setPreview).catch(() => setPreview(null)); }, 300);
    return () => clearTimeout(t);
  }, [edit]);
  const save = async () => {
    if (!edit) return;
    try { await api(edit.id ? `/api/v1/marketing/segments/${edit.id}` : '/api/v1/marketing/segments', { method: edit.id ? 'PUT' : 'POST', body: { name: edit.name, filter: { conditions: edit.conditions } } }); toast.success('Segment saved'); setEdit(null); await invalidateMarketing(qc); } catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end"><Button variant="primary" onClick={() => setEdit({ id: null, name: '', conditions: [] })}><Plus /> New segment</Button></div>
      {!data ? <Skeleton className="h-40" /> : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.rows.map((s) => (
            <Card key={s.id} className="flex flex-col gap-2 p-4">
              <div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg bg-info-dim text-info"><Users className="size-4" /></span><span className="min-w-0 flex-1 truncate font-medium">{s.name}</span><span className="tnum text-[18px] font-semibold">{fmtInt(s.size)}</span></div>
              <div className="line-clamp-2 text-[11.5px] text-subtle">{s.filter.conditions.length ? s.filter.conditions.map((c) => `${c.field} ${c.op} ${Array.isArray(c.value) ? c.value.join(', ') : c.value ?? ''}`).join(' · ') : 'All leads'}</div>
              <div className="flex gap-1.5 pt-1"><Button size="xs" variant="ghost" onClick={() => setEdit({ id: s.id, name: s.name, conditions: s.filter.conditions })}>Edit</Button><Button size="xs" variant="ghost" onClick={async () => { await api(`/api/v1/marketing/segments/${s.id}`, { method: 'DELETE' }); await invalidateMarketing(qc); }}><Trash2 /></Button></div>
            </Card>
          ))}
          {!data.rows.length && <Card className="py-10 text-center text-[12.5px] text-subtle md:col-span-3">Segments are saved lead groups (e.g. “Pune solar leads, contacted, not converted”) that stay up to date — use them for sequences and broadcasts.</Card>}
        </div>
      )}
      {edit && (
        <Dialog open onOpenChange={(o) => !o && setEdit(null)} title={edit.id ? 'Edit segment' : 'New segment'} size="lg" footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" disabled={edit.name.trim().length < 2} onClick={save}>Save</Button></>}>
          <div className="flex flex-col gap-3">
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. Hot solar leads in Pune" autoFocus /></Field>
            <div><div className="mb-1.5 text-[12px] font-medium">Leads that match</div><FilterBuilder fields={clientLeadFields(facets.data, true)} value={edit.conditions} onChange={(c) => setEdit({ ...edit, conditions: c })} /></div>
            {preview && <div className="grid grid-cols-3 gap-2 text-center">{([['Leads', preview.total], ['With phone', preview.withPhone], ['With email', preview.withEmail]] as const).map(([k, v]) => <div key={k} className="rounded-lg border border-border py-2"><div className="tnum text-[18px] font-semibold">{fmtInt(v)}</div><div className="text-[11px] text-subtle">{k}</div></div>)}</div>}
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ── Sequences ──────────────────────────────────────────────────────

type Seq = { id: string; name: string; status: string; steps: SequenceStep[]; stopOnReply: boolean; stopOnStatus: string[]; segmentId: string | null; autoEnroll: boolean; enrolledCount: number; stats: Record<string, number> };
type Draft = Omit<Seq, 'id' | 'status' | 'enrolledCount' | 'stats'>;
const newStep = (type: SequenceStep['type']): SequenceStep => ({ id: `s${Math.random().toString(36).slice(2, 8)}`, type, delayHours: type === 'task' ? 24 : 0, body: type === 'whatsapp' ? 'Hi {first_name|there}, this is {sender_name} from {workspace}. ' : type === 'sms' ? '{workspace}: ' : null, title: type === 'task' ? 'Call {first_name}' : null, templateId: null });

function SequencesTab({ features }: { features: Overview['features'] }) {
  const qc = useQueryClient();
  const { data } = useApiQuery<{ rows: Seq[] }>('/api/v1/marketing/sequences');
  const library = useApiQuery<{ rows: { id: string; kind: string; name: string; description: string | null }[] }>('/api/v1/marketing/library');
  const segments = useApiQuery<{ rows: Segment[] }>(features.segments ? '/api/v1/marketing/segments' : null);
  const templates = useApiQuery<{ templates: { id: string; name: string }[] }>('/api/v1/email/templates');
  const [edit, setEdit] = useState<{ id: string | null; d: Draft } | null>(null);
  const [enrollIn, setEnrollIn] = useState<Seq | null>(null);
  const [segPick, setSegPick] = useState('');
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast.success(msg); await invalidateMarketing(qc); } catch (e) { toast.error(errorMessage(e)); } };
  const save = () => edit && act(async () => { await api(edit.id ? `/api/v1/marketing/sequences/${edit.id}` : '/api/v1/marketing/sequences', { method: edit.id ? 'PUT' : 'POST', body: edit.d }); setEdit(null); }, 'Sequence saved');
  const types = (['email', 'whatsapp', 'sms', 'task'] as const).filter((t) => t === 'email' || t === 'task' || features[t]);
  const d = edit?.d;
  const setStep = (i: number, p: Partial<SequenceStep>) => edit && setEdit({ ...edit, d: { ...edit.d, steps: edit.d.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) } });
  const move = (i: number, dir: -1 | 1) => { if (!edit) return; const st = [...edit.d.steps]; const [x] = st.splice(i, 1); st.splice(i + dir, 0, x); setEdit({ ...edit, d: { ...edit.d, steps: st } }); };
  const seqLib = (library.data?.rows ?? []).filter((r) => r.kind === 'SEQUENCE');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {seqLib.length > 0 && <Select className="h-8 w-56 text-[12.5px]" value="" onChange={(e) => e.target.value && act(() => api(`/api/v1/marketing/library/${e.target.value}/use`, { method: 'POST' }), 'Template added as a draft')} aria-label="Start from a template"><option value="">Start from a template…</option>{seqLib.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}
        <Button variant="primary" onClick={() => setEdit({ id: null, d: { name: '', steps: [newStep(features.whatsapp ? 'whatsapp' : 'task'), { ...newStep('task'), delayHours: 48 }], stopOnReply: true, stopOnStatus: ['CONVERTED', 'LOST'], segmentId: null, autoEnroll: false } })}><Plus /> New sequence</Button>
      </div>
      {!data ? <Skeleton className="h-40" /> : (
        <div className="flex flex-col gap-3">
          {data.rows.map((s) => (
            <Card key={s.id} className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid size-8 place-items-center rounded-lg bg-info-dim text-info"><Workflow className="size-4" /></span>
                <span className="font-medium">{s.name}</span><StatusBadge status={s.status} />
                {s.autoEnroll && <span className="rounded-full bg-accent-dim px-2 py-0.5 text-[10.5px] text-accent">auto-enrols segment</span>}
                <span className="ml-auto text-[12px] text-subtle">{fmtInt(s.enrolledCount)} enrolled · {fmtInt(s.stats.ACTIVE ?? 0)} active · {fmtInt(s.stats.COMPLETED ?? 0)} done · {fmtInt(s.stats.STOPPED ?? 0)} stopped</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {s.steps.map((st, i) => { const M = STEP_META[st.type]; return <span key={st.id} className="flex items-center gap-1.5">{i > 0 && <span className="text-[10.5px] text-subtle">→ {st.delayHours ? `${st.delayHours >= 24 ? `${Math.round(st.delayHours / 24)}d` : `${st.delayHours}h`}` : 'now'}</span>}<span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]', M.tone)}><M.icon className="size-3" />{M.label}</span></span>; })}
              </div>
              <div className="flex flex-wrap gap-2">
                {s.status === 'ACTIVE' ? <Button size="sm" variant="ghost" onClick={() => act(() => api(`/api/v1/marketing/sequences/${s.id}/status`, { body: { status: 'PAUSED' } }), 'Paused')}><Pause /> Pause</Button> : <Button size="sm" variant="primary" onClick={() => act(() => api(`/api/v1/marketing/sequences/${s.id}/status`, { body: { status: 'ACTIVE' } }), 'Sequence is live')}><Play /> Activate</Button>}
                {s.status === 'ACTIVE' && features.segments && <Button size="sm" onClick={() => { setEnrollIn(s); setSegPick(''); }}><Users /> Enrol a segment</Button>}
                <Button size="sm" variant="ghost" onClick={() => setEdit({ id: s.id, d: { name: s.name, steps: s.steps, stopOnReply: s.stopOnReply, stopOnStatus: s.stopOnStatus, segmentId: s.segmentId, autoEnroll: s.autoEnroll } })}>Edit</Button>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => act(() => api(`/api/v1/marketing/sequences/${s.id}`, { method: 'DELETE' }), 'Deleted')} aria-label="Delete"><Trash2 /></Button>
              </div>
            </Card>
          ))}
          {!data.rows.length && <Card className="py-12 text-center text-[12.5px] text-subtle">Build a follow-up like “WhatsApp now → call task in 2 days → email in 4 days”. It stops by itself when the lead replies or converts.</Card>}
        </div>
      )}
      {edit && d && (
        <Dialog open onOpenChange={(o) => !o && setEdit(null)} title={edit.id ? 'Edit sequence' : 'New sequence'} size="xl" footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" disabled={d.name.trim().length < 2 || !d.steps.length} onClick={save}>Save sequence</Button></>}>
          <div className="flex flex-col gap-4">
            <Field label="Name"><Input value={d.name} onChange={(e) => setEdit({ ...edit, d: { ...d, name: e.target.value } })} placeholder="e.g. New lead follow-up" autoFocus /></Field>
            <ol className="flex flex-col gap-2">
              {d.steps.map((st, i) => {
                const M = STEP_META[st.type];
                return (
                  <li key={st.id} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tnum grid size-6 place-items-center rounded-full bg-surface-3 text-[11px] font-semibold">{i + 1}</span>
                      <Select className="h-8 w-36" value={st.type} onChange={(e) => setStep(i, { ...newStep(e.target.value as SequenceStep['type']), id: st.id, delayHours: st.delayHours })} aria-label="Step type">{types.map((t) => <option key={t} value={t}>{STEP_META[t].label}</option>)}</Select>
                      <span className="text-[12px] text-muted">after</span>
                      <Input type="number" min={0} className="h-8 w-20" value={st.delayHours >= 24 && st.delayHours % 24 === 0 ? st.delayHours / 24 : st.delayHours} onChange={(e) => setStep(i, { delayHours: Math.max(0, Math.round(Number(e.target.value))) * (st.delayHours >= 24 && st.delayHours % 24 === 0 ? 24 : 1) })} aria-label="Delay" />
                      <Select className="h-8 w-24" value={st.delayHours >= 24 && st.delayHours % 24 === 0 ? 'd' : 'h'} onChange={(e) => setStep(i, { delayHours: e.target.value === 'd' ? Math.max(1, Math.round(st.delayHours / 24) || 1) * 24 : st.delayHours >= 24 ? st.delayHours : st.delayHours })} aria-label="Unit"><option value="h">hours</option><option value="d">days</option></Select>
                      <span className={cn('ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]', M.tone)}><M.icon className="size-3" />{M.label}</span>
                      <span className="ml-auto flex gap-1"><Button size="xs" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Up"><ArrowUp /></Button><Button size="xs" variant="ghost" disabled={i === d.steps.length - 1} onClick={() => move(i, 1)} aria-label="Down"><ArrowDown /></Button><Button size="xs" variant="ghost" onClick={() => setEdit({ ...edit, d: { ...d, steps: d.steps.filter((_, j) => j !== i) } })} aria-label="Remove"><X /></Button></span>
                    </div>
                    <div className="mt-2">
                      {st.type === 'email' && <Select value={st.templateId ?? ''} onChange={(e) => setStep(i, { templateId: e.target.value || null })} aria-label="Email template"><option value="">Choose an email template…</option>{(templates.data?.templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}
                      {(st.type === 'whatsapp' || st.type === 'sms') && <Textarea rows={3} value={st.body ?? ''} maxLength={1600} onChange={(e) => setStep(i, { body: e.target.value })} placeholder="Message…" />}
                      {st.type === 'task' && <Input value={st.title ?? ''} onChange={(e) => setStep(i, { title: e.target.value })} placeholder="e.g. Call to qualify" />}
                      {(st.type === 'whatsapp' || st.type === 'sms') && <div className="mt-1 flex flex-wrap gap-1">{MERGE_TAGS.map((t) => <button key={t} type="button" onClick={() => setStep(i, { body: `${st.body ?? ''}{${t}}` })} className="rounded border border-border px-1.5 text-[10.5px] text-muted hover:text-fg">{`{${t}}`}</button>)}<span className="text-[10.5px] text-subtle">· {'{link:CODE}'} inserts a tracked link</span></div>}
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="flex flex-wrap gap-2">{types.map((t) => { const M = STEP_META[t]; return <Button key={t} size="sm" variant="outline" onClick={() => setEdit({ ...edit, d: { ...d, steps: [...d.steps, { ...newStep(t), delayHours: 24 }] } })}><M.icon /> Add {M.label}</Button>; })}</div>
            <div className="grid grid-cols-1 gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
              <label className="flex items-center justify-between gap-2 text-[12.5px]">Stop when the lead replies<Switch checked={d.stopOnReply} onCheckedChange={(v) => setEdit({ ...edit, d: { ...d, stopOnReply: v } })} aria-label="Stop on reply" /></label>
              <div className="flex flex-wrap items-center gap-1.5 text-[12px]"><span className="text-muted">Stop at status:</span>{['QUALIFIED', 'CONVERTED', 'LOST'].map((st) => { const on = d.stopOnStatus.includes(st); return <button key={st} type="button" onClick={() => setEdit({ ...edit, d: { ...d, stopOnStatus: on ? d.stopOnStatus.filter((x) => x !== st) : [...d.stopOnStatus, st] } })} className={cn('rounded-full border px-2 py-0.5 text-[11px]', on ? 'border-fg bg-fg text-inverse' : 'border-border text-muted')}>{st.toLowerCase()}</button>; })}</div>
              {features.segments && <Field label="Segment (optional)" className="sm:col-span-2"><div className="flex items-center gap-3"><Select value={d.segmentId ?? ''} onChange={(e) => setEdit({ ...edit, d: { ...d, segmentId: e.target.value || null, autoEnroll: e.target.value ? d.autoEnroll : false } })}><option value="">None</option>{(segments.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({fmtInt(s.size)})</option>)}</Select><label className="flex shrink-0 items-center gap-2 text-[12.5px] text-muted"><Switch checked={d.autoEnroll} disabled={!d.segmentId} onCheckedChange={(v) => setEdit({ ...edit, d: { ...d, autoEnroll: v } })} aria-label="Auto-enrol" />Auto-enrol new members</label></div></Field>}
            </div>
          </div>
        </Dialog>
      )}
      {enrollIn && (
        <Dialog open onOpenChange={(o) => !o && setEnrollIn(null)} title={`Enrol a segment in “${enrollIn.name}”`} footer={<><Button variant="ghost" onClick={() => setEnrollIn(null)}>Cancel</Button><Button variant="primary" disabled={!segPick} onClick={() => act(async () => { const r = await api<{ enrolled: number }>(`/api/v1/marketing/sequences/${enrollIn.id}/enroll`, { body: { segmentId: segPick } }); toast.message(`${r.enrolled} leads enrolled`); setEnrollIn(null); }, 'Enrolled')}>Enrol</Button></>}>
          <Select value={segPick} onChange={(e) => setSegPick(e.target.value)} aria-label="Segment"><option value="">Choose a segment…</option>{(segments.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({fmtInt(s.size)})</option>)}</Select>
          <p className="mt-2 text-[11.5px] text-subtle">Leads already in this sequence, or already converted/lost, are skipped.</p>
        </Dialog>
      )}
    </div>
  );
}

// ── Broadcasts ─────────────────────────────────────────────────────

type Broadcast = { id: string; name: string; channel: string; body: string; status: string; total: number; sent: number; failed: number; skipped: number; reviewNote: string | null; createdAt: string };

function BroadcastsTab({ o }: { o: Overview }) {
  const qc = useQueryClient();
  const { data } = useApiQuery<{ rows: Broadcast[] }>('/api/v1/marketing/broadcasts', { refetchInterval: 15_000 });
  const segments = useApiQuery<{ rows: Segment[] }>('/api/v1/marketing/segments');
  const [d, setD] = useState<{ name: string; channel: 'WHATSAPP' | 'SMS'; body: string; segmentId: string } | null>(null);
  const channels = (['WHATSAPP', 'SMS'] as const).filter((c) => o.features[c === 'WHATSAPP' ? 'whatsapp' : 'sms']);
  const seg = segments.data?.rows.find((s) => s.id === d?.segmentId);
  const create = async () => {
    if (!d) return;
    try { const r = await api<Broadcast>('/api/v1/marketing/broadcasts', { body: d }); toast.success(r.status === 'PENDING_REVIEW' ? 'Sent for platform review (large audience)' : 'Broadcast queued'); setD(null); await invalidateMarketing(qc); } catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end"><Button variant="primary" disabled={!channels.length} onClick={() => setD({ name: '', channel: channels[0], body: 'Hi {first_name|there}, ', segmentId: '' })}><Radio /> New broadcast</Button></div>
      <Card>
        <ul className="flex flex-col divide-y divide-border">
          {(data?.rows ?? []).map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[12.5px]">
              <span className={cn('grid size-8 place-items-center rounded-lg', b.channel === 'WHATSAPP' ? 'bg-ok-dim text-ok' : 'bg-accent-dim text-accent')}>{b.channel === 'WHATSAPP' ? <MessageCircle className="size-4" /> : <MessageSquareText className="size-4" />}</span>
              <div className="min-w-0 flex-1"><div className="font-medium">{b.name}</div><div className="truncate text-[11.5px] text-subtle">{b.body}</div>{b.reviewNote && <div className="text-[11.5px] text-warn">{b.reviewNote}</div>}</div>
              <div className="w-40"><div className="h-1.5 rounded-full bg-surface-3"><div className="h-full rounded-full bg-ok" style={{ width: `${b.total ? ((b.sent + b.failed + b.skipped) / b.total) * 100 : 0}%` }} /></div><div className="mt-1 text-[11px] text-subtle">{fmtInt(b.sent)} sent · {fmtInt(b.failed)} failed · {fmtInt(b.skipped)} skipped / {fmtInt(b.total)}</div></div>
              <StatusBadge status={b.status} />
              <span className="text-[11px] text-subtle">{fmtAgo(b.createdAt)}</span>
              {['PENDING_REVIEW', 'QUEUED', 'SENDING'].includes(b.status) && <Button size="xs" variant="ghost" onClick={async () => { await api(`/api/v1/marketing/broadcasts/${b.id}/cancel`, { method: 'POST' }); await invalidateMarketing(qc); }}>Cancel</Button>}
            </li>
          ))}
          {data && !data.rows.length && <li className="py-10 text-center text-[12.5px] text-subtle">Send a WhatsApp or SMS to a whole segment — opt-outs, quiet hours and limits are handled for you.</li>}
        </ul>
      </Card>
      {d && (
        <Dialog open onOpenChange={(x) => !x && setD(null)} title="New broadcast" size="lg" footer={<><Button variant="ghost" onClick={() => setD(null)}>Cancel</Button><Button variant="primary" disabled={!d.segmentId || d.name.trim().length < 2 || !d.body.trim()} onClick={create}><Send /> Send to {seg ? fmtInt(seg.size) : '…'} leads</Button></>}>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Name" className="sm:col-span-2"><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Diwali offer" /></Field>
              <Field label="Channel"><Select value={d.channel} onChange={(e) => setD({ ...d, channel: e.target.value as 'WHATSAPP' | 'SMS' })}>{channels.map((c) => <option key={c} value={c}>{c === 'WHATSAPP' ? 'WhatsApp' : 'SMS'}</option>)}</Select></Field>
            </div>
            <Field label="Send to"><Select value={d.segmentId} onChange={(e) => setD({ ...d, segmentId: e.target.value })}><option value="">Choose a segment…</option>{(segments.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({fmtInt(s.size)})</option>)}</Select></Field>
            <Field label="Message" hint={`${d.body.length} characters · ${d.channel === 'WHATSAPP' ? o.pricing.whatsapp : o.pricing.sms} credit${(d.channel === 'WHATSAPP' ? o.pricing.whatsapp : o.pricing.sms) === 1 ? '' : 's'} per lead`}><Textarea rows={5} value={d.body} maxLength={1600} onChange={(e) => setD({ ...d, body: e.target.value })} /></Field>
            <div className="flex flex-wrap gap-1">{MERGE_TAGS.map((t) => <button key={t} type="button" onClick={() => setD({ ...d, body: `${d.body}{${t}}` })} className="rounded border border-border px-1.5 text-[10.5px] text-muted hover:text-fg">{`{${t}}`}</button>)}</div>
            {d.channel === 'SMS' && !/stop/i.test(d.body) && <InlineNotice tone="warn">Add an opt-out line such as “Reply STOP to opt out”.</InlineNotice>}
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────

export function MarketingApp() {
  const [s, set] = useUrlState({ tab: 'overview' });
  const { data: o } = useApiQuery<Overview>('/api/v1/marketing/overview', { refetchInterval: 60_000 });
  const tabs: { key: string; label: string; icon: React.ComponentType<{ className?: string }>; on: boolean }[] = o ? [
    { key: 'overview', label: 'Overview', icon: BarChart3, on: true },
    { key: 'sequences', label: 'Sequences', icon: Workflow, on: o.features.sequences },
    { key: 'broadcasts', label: 'Broadcasts', icon: Radio, on: o.features.broadcasts && (o.features.whatsapp || o.features.sms) },
    { key: 'segments', label: 'Segments', icon: Users, on: o.features.segments },
    { key: 'forms', label: 'Lead forms', icon: FileInput, on: o.features.forms },
    { key: 'links', label: 'Links & QR', icon: QrCode, on: o.features.links },
    { key: 'writer', label: 'AI writer', icon: Bot, on: o.features.aiWriter },
  ].filter((t) => t.on) : [];
  const tab = tabs.some((t) => t.key === s.tab) ? s.tab : 'overview';
  return (
    <>
      <PageHeader eyebrow="Grow" title="Marketing" description="Follow-up sequences, WhatsApp & SMS broadcasts, lead forms, tracked links and an AI writer — everything to turn leads into customers." />
      {!o ? <Skeleton className="h-96" /> : (
        <>
          <Tabs value={tab} onValueChange={(v) => set({ tab: v })}>
            <TabsList className="mb-4 overflow-x-auto">{tabs.map((t) => <TabsTrigger key={t.key} value={t.key}><span className="inline-flex items-center gap-1.5"><t.icon className="size-3.5" />{t.label}</span></TabsTrigger>)}</TabsList>
          </Tabs>
          {tab === 'overview' && <OverviewTab o={o} go={(t) => set({ tab: t })} />}
          {tab === 'sequences' && <SequencesTab features={o.features} />}
          {tab === 'broadcasts' && <BroadcastsTab o={o} />}
          {tab === 'segments' && <SegmentsTab />}
          {tab === 'forms' && <FormsTab />}
          {tab === 'links' && <LinksTab />}
          {tab === 'writer' && <WriterTab pricing={o.pricing.aiDraft} />}
        </>
      )}
    </>
  );
}
