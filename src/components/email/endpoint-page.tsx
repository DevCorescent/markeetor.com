'use client';
import { ArrowDown, ArrowUp, Check, Copy, ExternalLink, FlaskConical, KeyRound, Pause, Play, Plus, RefreshCw, RotateCcw, Save, Trash2, Webhook, X, Zap } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, Drawer, Switch, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { SimpleTable } from '@/components/ui/simple-table';
import { ErrorState, InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import {
  CONDITION_OPS, defaultEndpointConfig, ENDPOINT_EVENTS, payloadVariables, WEBHOOK_SAMPLE,
  type ConditionOp, type EndpointConfig, type EndpointInput,
} from '@/lib/email/endpoints';
import { fmtAgo, fmtDateTime, fmtInt, fmtPct } from '@/lib/format';
import { useApiMutation, useApiQuery, useUrlState } from '@/lib/hooks';
import { MailHistory } from './mail-history';

type Options = { templates: { id: string; name: string; subject: string; updatedAt: string }[]; senders: { id: string; label: string; fromEmail: string; status: string; isDefault: boolean }[] };
type Stats = { triggers: number; triggers24h: number; accepted: number; filtered: number; queued: number; sent: number; failed: number; skipped: number; opened: number; clicked: number };
type Saved = EndpointInput & { id: string; slug: string; webhookUrl: string | null; tokenPreview: string | null; hasSigningSecret: boolean; lastTriggeredAt: string | null; stats: Stats | null };
type Secrets = { token?: string; signingSecret?: string };

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const UNITS = [{ key: 'minutes', n: 1 }, { key: 'hours', n: 60 }, { key: 'days', n: 1440 }] as const;
const secretKey = (id: string) => `endpoint-secrets:${id}`;

function blank(type: 'EVENT' | 'WEBHOOK'): EndpointInput {
  const ev = type === 'EVENT' ? ENDPOINT_EVENTS[0] : undefined;
  return {
    name: type === 'WEBHOOK' ? 'New webhook endpoint' : ev!.label, description: null, status: 'ACTIVE', triggerType: type, event: ev?.key ?? null,
    category: 'TRANSACTIONAL', smtpAccountId: null, config: defaultEndpointConfig(ev ?? { key: '', label: '', description: '', recipientPath: 'email', namePath: 'name', sample: {} }),
  };
}

/** Dotted paths and sample values of a payload, for path pickers. */
function paths(obj: unknown, prefix = '', out: { path: string; sample: string }[] = []) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) paths(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out.push({ path: prefix, sample: obj === null || obj === undefined ? '' : String(obj) });
  return out;
}

export function EndpointPage({ base, id }: { base: string; id: string }) {
  const router = useRouter();
  const sp = useSearchParams();
  const isNew = id === 'new';
  const saved = useApiQuery<Saved>(isNew ? null : `/api/v1/email/endpoints/${id}`, { refetchInterval: 30_000 });
  const options = useApiQuery<Options>('/api/v1/email/endpoints/options');
  const [draft, setDraft] = useState<EndpointInput | null>(null);
  const [s, setS] = useUrlState({ tab: 'setup' });
  const [secrets, setSecrets] = useState<Secrets | null>(() => {
    if (isNew || typeof window === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem(secretKey(id));
      if (raw) sessionStorage.removeItem(secretKey(id));
      return raw ? (JSON.parse(raw) as Secrets) : null;
    } catch {
      return null;
    }
  });
  const [testOpen, setTestOpen] = useState(false);
  const [del, setDel] = useState(false);

  const base0 = isNew ? blank(sp.get('type') === 'webhook' ? 'WEBHOOK' : 'EVENT') : saved.data ? { name: saved.data.name, description: saved.data.description, status: saved.data.status, triggerType: saved.data.triggerType, event: saved.data.event, category: saved.data.category, smtpAccountId: saved.data.smtpAccountId, config: saved.data.config } as EndpointInput : null;
  const v = draft ?? base0;
  const dirty = draft !== null;

  const save = useApiMutation(
    (body: EndpointInput) => api<{ endpoint: { id: string }; token?: string; signingSecret?: string }>(isNew ? '/api/v1/email/endpoints' : `/api/v1/email/endpoints/${id}`, { method: isNew ? 'POST' : 'PUT', body }),
    {
      success: 'Endpoint saved', invalidate: ['/api/v1/email/endpoints'],
      onSuccess: (r) => {
        setDraft(null);
        const fresh = r.token || r.signingSecret ? { token: r.token, signingSecret: r.signingSecret } : null;
        if (isNew) {
          if (fresh) try { sessionStorage.setItem(secretKey(r.endpoint.id), JSON.stringify(fresh)); } catch {}
          router.replace(`${base}/email/endpoints/${r.endpoint.id}`);
        } else if (fresh) setSecrets(fresh);
      },
    },
  );
  const remove = useApiMutation(() => api(`/api/v1/email/endpoints/${id}`, { method: 'DELETE' }), { success: 'Endpoint deleted', invalidate: ['/api/v1/email/endpoints'], onSuccess: () => router.push(`${base}/email?tab=endpoints`) });

  if (saved.error) return <ErrorState description={errorMessage(saved.error)} />;
  if (!v || !options.data) return <Skeleton className="h-[720px]" />;
  const set = (patch: Partial<EndpointInput>) => setDraft({ ...v, ...patch });
  const setCfg = <K extends keyof EndpointConfig>(k: K, patch: Partial<EndpointConfig[K]>) => set({ config: { ...v.config, [k]: { ...(v.config[k] as object), ...patch } } });
  const ev = ENDPOINT_EVENTS.find((e) => e.key === v.event);
  const sample = v.triggerType === 'WEBHOOK' ? WEBHOOK_SAMPLE : ev?.sample ?? {};
  const st = saved.data?.stats;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Email', href: `${base}/email` }, { label: 'Endpoints', href: `${base}/email?tab=endpoints` }, { label: isNew ? 'New' : v.name }]}
        title={isNew ? (v.triggerType === 'WEBHOOK' ? 'New webhook endpoint' : 'New endpoint') : v.name}
        description={v.triggerType === 'WEBHOOK' ? 'Sends the attached emails whenever another system calls this endpoint’s URL.' : ev?.description}
        actions={
          <>
            {!isNew && <Button onClick={() => set({ status: v.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}>{v.status === 'ACTIVE' ? <><Pause /> Pause</> : <><Play /> Resume</>}</Button>}
            {!isNew && <Button disabled={dirty} title={dirty ? 'Save your changes first' : undefined} onClick={() => setTestOpen(true)}><FlaskConical /> Send test</Button>}
            <Button variant="primary" loading={save.isPending} disabled={!dirty && !isNew} onClick={() => save.mutate(v)}><Save /> {isNew ? 'Create endpoint' : 'Save'}</Button>
          </>
        }
      />
      {!isNew && st && (
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-muted">
          <Badge tone={v.status === 'ACTIVE' ? 'ok' : 'neutral'} dot>{v.status === 'ACTIVE' ? 'Active' : 'Paused'}</Badge>
          <span><span className="tnum text-fg">{fmtInt(st.triggers)}</span> triggers · 30d</span>
          <span><span className="tnum text-fg">{fmtInt(st.sent)}</span> sent</span>
          <span><span className="tnum text-fg">{fmtInt(st.queued)}</span> queued</span>
          <span className={st.failed ? 'text-danger' : ''}><span className="tnum">{fmtInt(st.failed)}</span> failed</span>
          <span><span className="tnum text-fg">{fmtPct(st.sent ? st.opened / st.sent : null, 0)}</span> opened</span>
          <span><span className="tnum text-fg">{fmtPct(st.sent ? st.clicked / st.sent : null, 0)}</span> clicked</span>
          <span>Last triggered {saved.data?.lastTriggeredAt ? fmtAgo(saved.data.lastTriggeredAt) : 'never'}</span>
        </div>
      )}
      {!isNew && (
        <Tabs value={s.tab} onValueChange={(t) => setS({ tab: t })}>
          <TabsList className="mb-5">
            <TabsTrigger value="setup">Setup</TabsTrigger>
            <TabsTrigger value="triggers">Trigger log</TabsTrigger>
            <TabsTrigger value="emails">Emails sent</TabsTrigger>
            {v.triggerType === 'WEBHOOK' && <TabsTrigger value="webhook">Webhook</TabsTrigger>}
          </TabsList>
        </Tabs>
      )}
      {(isNew || s.tab === 'setup') && (
        <Setup v={v} set={set} setCfg={setCfg} options={options.data} sample={sample} isNew={isNew} base={base} onRefreshTemplates={() => options.refetch()} onDelete={() => setDel(true)} />
      )}
      {!isNew && s.tab === 'triggers' && <TriggerLog id={id} />}
      {!isNew && s.tab === 'emails' && <MailHistory endpointId={id} base={base} canManage />}
      {!isNew && s.tab === 'webhook' && saved.data && <WebhookPanel ep={saved.data} requireSignature={v.config.webhook.requireSignature} onSecrets={setSecrets} />}

      {dirty && (
        <div className="sticky bottom-4 z-20 mt-4 flex items-center justify-between gap-3 rounded-lg border border-border-strong bg-surface-2 px-4 py-2.5 shadow-[var(--raised-shadow)] animate-pop">
          <span className="text-[12.5px] text-muted">You have unsaved changes</span>
          <span className="flex gap-2"><Button variant="ghost" onClick={() => setDraft(null)}>Discard</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(v)}>Save changes</Button></span>
        </div>
      )}
      {secrets && <SecretsDialog secrets={secrets} onClose={() => setSecrets(null)} />}
      {testOpen && <TestDialog id={id} sample={sample} onClose={() => setTestOpen(false)} />}
      <ConfirmDialog open={del} onOpenChange={setDel} danger title={`Delete “${v.name}”`} description="The endpoint stops accepting triggers immediately and its queued emails are cancelled. Its history is kept." confirmLabel="Delete endpoint" onConfirm={() => remove.mutateAsync(undefined)} />
    </>
  );
}

// ── Setup ──────────────────────────────────────────────────────────

function Setup({ v, set, setCfg, options, sample, isNew, base, onRefreshTemplates, onDelete }: {
  v: EndpointInput; set: (p: Partial<EndpointInput>) => void; setCfg: <K extends keyof EndpointConfig>(k: K, p: Partial<EndpointConfig[K]>) => void;
  options: Options; sample: Record<string, unknown>; isNew: boolean; base: string; onRefreshTemplates: () => void; onDelete: () => void;
}) {
  const c = v.config;
  const pathList = useMemo(() => paths(sample), [sample]);
  const autoVars = useMemo(() => Object.entries(payloadVariables(sample, c.variables)), [sample, c.variables]);
  const timezones = useMemo(() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC']; } }, []);
  const steps = c.steps;
  const setSteps = (next: EndpointConfig['steps']) => set({ config: { ...c, steps: next } });
  const rules = c.conditions.rules;
  const setRules = (next: EndpointConfig['conditions']['rules']) => setCfg('conditions', { rules: next });

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <datalist id="payload-paths">{pathList.map((p) => <option key={p.path} value={p.path}>{p.sample}</option>)}</datalist>
      <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardHeader title="Basics" />
          <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={v.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Send from">
              <Select value={v.smtpAccountId ?? ''} onChange={(e) => set({ smtpAccountId: e.target.value || null })}>
                <option value="">Default platform sender</option>
                {options.senders.map((x) => <option key={x.id} value={x.id}>{x.label} · {x.fromEmail}{x.status !== 'VERIFIED' ? ` (${x.status.toLowerCase()})` : ''}</option>)}
              </Select>
            </Field>
            <Field label="Description" className="sm:col-span-2"><Input value={v.description ?? ''} maxLength={500} placeholder="What this endpoint is for (optional)" onChange={(e) => set({ description: e.target.value || null })} /></Field>
            <Field label="Type of email" className="sm:col-span-2" hint={v.category === 'MARKETING' ? 'Adds a one-click unsubscribe header and is never sent to anyone who unsubscribed.' : 'Account and order emails people expect. Still never sent to bounced or blocked addresses.'}>
              <Seg value={v.category} onChange={(x) => set({ category: x as EndpointInput['category'] })} items={[['TRANSACTIONAL', 'Transactional'], ['MARKETING', 'Marketing']]} />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Trigger" description="What makes this endpoint send." />
          <CardBody className="flex flex-col gap-3">
            {isNew && <Seg value={v.triggerType} onChange={(x) => set({ triggerType: x as 'EVENT' | 'WEBHOOK', event: x === 'EVENT' ? (v.event ?? ENDPOINT_EVENTS[0].key) : null, config: { ...c, recipients: { ...c.recipients, path: x === 'WEBHOOK' ? 'email' : ENDPOINT_EVENTS[0].recipientPath, namePath: x === 'WEBHOOK' ? 'name' : (ENDPOINT_EVENTS[0].namePath ?? '') } } })} items={[['EVENT', 'markeetor event'], ['WEBHOOK', 'Webhook URL (any system)']]} />}
            {v.triggerType === 'EVENT' ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {ENDPOINT_EVENTS.map((e) => (
                  <button key={e.key} type="button" onClick={() => set({ event: e.key, config: { ...c, recipients: { ...c.recipients, path: e.recipientPath, namePath: e.namePath ?? '' } } })}
                    className={cn('rounded-lg border px-3 py-2.5 text-left transition-colors', v.event === e.key ? 'border-fg bg-surface-2' : 'border-border hover:border-border-strong')}>
                    <div className="flex items-center gap-1.5 text-[12.5px] text-fg"><Zap className="size-3.5 text-subtle" />{e.label}</div>
                    <div className="mt-0.5 text-[11.5px] text-subtle">{e.description}</div>
                  </button>
                ))}
              </div>
            ) : (
              <InlineNotice>{isNew ? 'After you create it, the Webhook tab shows the URL, a secret token and ready-to-copy code.' : 'Any system that can send an HTTPS POST with JSON can trigger this endpoint. See the Webhook tab for the URL, token and code samples.'}</InlineNotice>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Emails to send" description="Attach one or more emails. Each is sent after its delay, counted from the trigger."
            actions={<span className="flex gap-1.5"><Link href={`${base}/email/templates/new`} target="_blank"><Button size="sm" variant="ghost"><ExternalLink /> New email</Button></Link><Button size="sm" variant="ghost" onClick={onRefreshTemplates} aria-label="Reload templates"><RefreshCw /></Button></span>} />
          <CardBody className="flex flex-col gap-2.5">
            {!options.templates.length && <InlineNotice tone="warn">You have no email templates yet. Create one with “New email”, then reload.</InlineNotice>}
            {steps.map((step, i) => {
              const unit = [...UNITS].reverse().find((u) => step.delayMinutes % u.n === 0) ?? UNITS[0];
              return (
                <div key={step.id} className={cn('rounded-lg border border-border p-3', !step.enabled && 'opacity-60')}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="grid size-5 place-items-center rounded-full bg-surface-3 text-[10.5px] tnum">{i + 1}</span>
                    <Select className="flex-1" value={step.templateId} onChange={(e) => setSteps(steps.map((x) => (x.id === step.id ? { ...x, templateId: e.target.value } : x)))}>
                      {!options.templates.some((t) => t.id === step.templateId) && <option value={step.templateId}>Deleted template</option>}
                      {options.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </Select>
                    <Link href={`${base}/email/templates/${step.templateId}`} target="_blank" className="text-[11.5px] text-muted hover:text-fg">Edit</Link>
                    <Switch checked={step.enabled} onCheckedChange={(on) => setSteps(steps.map((x) => (x.id === step.id ? { ...x, enabled: on } : x)))} aria-label="Enabled" />
                    <Button size="icon" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => { const n = [...steps]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setSteps(n); }}><ArrowUp /></Button>
                    <Button size="icon" variant="ghost" aria-label="Move down" disabled={i === steps.length - 1} onClick={() => { const n = [...steps]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setSteps(n); }}><ArrowDown /></Button>
                    <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => setSteps(steps.filter((x) => x.id !== step.id))}><X /></Button>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[220px_1fr]">
                    <Field label="Send after">
                      <div className="flex gap-1.5">
                        <Input type="number" min={0} className="w-24" value={step.delayMinutes / unit.n} onChange={(e) => setSteps(steps.map((x) => (x.id === step.id ? { ...x, delayMinutes: Math.max(0, Math.round(Number(e.target.value) || 0)) * unit.n } : x)))} />
                        <Select className="w-28" value={unit.key} onChange={(e) => { const u = UNITS.find((x) => x.key === e.target.value)!; setSteps(steps.map((x) => (x.id === step.id ? { ...x, delayMinutes: Math.round(x.delayMinutes / unit.n) * u.n } : x))); }}>
                          {UNITS.map((u) => <option key={u.key} value={u.key}>{u.key}</option>)}
                        </Select>
                      </div>
                    </Field>
                    <Field label="Subject (optional)" hint={`Leave empty to use the template’s: “${options.templates.find((t) => t.id === step.templateId)?.subject ?? ''}”`}>
                      <Input value={step.subject ?? ''} maxLength={300} placeholder="Override the subject, e.g. Your order {{orderId}} is confirmed" onChange={(e) => setSteps(steps.map((x) => (x.id === step.id ? { ...x, subject: e.target.value || null } : x)))} />
                    </Field>
                  </div>
                </div>
              );
            })}
            <div>
              <Button size="sm" disabled={!options.templates.length || steps.length >= 10} onClick={() => setSteps([...steps, { id: `s${Date.now().toString(36)}`, templateId: options.templates[0].id, delayMinutes: steps.length ? 1440 : 0, subject: null, enabled: true }])}><Plus /> Attach email</Button>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recipients" />
          <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 sm:col-span-2">
              <span><span className="block text-[12.5px]">Send to the address in the {v.triggerType === 'WEBHOOK' ? 'request' : 'event'}</span><span className="block text-[11.5px] text-subtle">A field holding one address, a comma-separated list, or a list of {'{ email, name }'}.</span></span>
              <Switch checked={c.recipients.fromPayload} onCheckedChange={(on) => setCfg('recipients', { fromPayload: on })} aria-label="Send to payload address" />
            </label>
            {c.recipients.fromPayload && (
              <>
                <Field label="Email field"><Input list="payload-paths" className="font-mono text-[12px]" value={c.recipients.path} placeholder="lead.email" onChange={(e) => setCfg('recipients', { path: e.target.value.trim() })} /></Field>
                <Field label="Name field (optional)"><Input list="payload-paths" className="font-mono text-[12px]" value={c.recipients.namePath} placeholder="lead.fullName" onChange={(e) => setCfg('recipients', { namePath: e.target.value.trim() })} /></Field>
              </>
            )}
            <Field label="Also send to" hint="Fixed addresses, e.g. your team inbox."><EmailList value={c.recipients.fixed} onChange={(fixed) => setCfg('recipients', { fixed })} /></Field>
            <Field label="Reply-to (optional)"><Input type="email" value={c.recipients.replyTo ?? ''} placeholder="support@yourcompany.com" onChange={(e) => setCfg('recipients', { replyTo: e.target.value.trim().toLowerCase() || null })} /></Field>
            <Field label="CC"><EmailList value={c.recipients.cc} onChange={(cc) => setCfg('recipients', { cc })} /></Field>
            <Field label="BCC"><EmailList value={c.recipients.bcc} onChange={(bcc) => setCfg('recipients', { bcc })} /></Field>
            <Field label="Most recipients per trigger"><Input type="number" min={1} max={100} className="w-28" value={c.recipients.max} onChange={(e) => setCfg('recipients', { max: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })} /></Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Conditions" description="Only send when the trigger’s data matches. Text comparisons ignore case." />
          <CardBody className="flex flex-col gap-2">
            {rules.length > 1 && (
              <div className="flex items-center gap-2 text-[12.5px] text-muted">Send when <Select className="h-7 w-24" value={c.conditions.match} onChange={(e) => setCfg('conditions', { match: e.target.value as 'all' | 'any' })}><option value="all">all</option><option value="any">any</option></Select> of these are true</div>
            )}
            {rules.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_150px_1fr_auto] gap-1.5">
                <Input list="payload-paths" className="font-mono text-[12px]" placeholder="lead.country" value={r.path} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, path: e.target.value.trim() } : x)))} aria-label="Field" />
                <Select value={r.op} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, op: e.target.value as ConditionOp } : x)))} aria-label="Operator">{CONDITION_OPS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</Select>
                <Input disabled={r.op === 'exists' || r.op === 'not_exists'} placeholder={r.op === 'in' || r.op === 'not_in' ? 'India, United States' : 'value'} value={r.value} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} aria-label="Value" />
                <Button size="icon" variant="ghost" aria-label="Remove condition" onClick={() => setRules(rules.filter((_, j) => j !== i))}><X /></Button>
              </div>
            ))}
            {!rules.length && <p className="text-[12px] text-subtle">No conditions: every trigger sends.</p>}
            <div><Button size="sm" disabled={rules.length >= 25} onClick={() => setRules([...rules, { path: pathList[0]?.path ?? 'email', op: 'eq', value: '' }])}><Plus /> Add condition</Button></div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Delivery & limits" />
          <CardBody className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <ToggleRow label="Only send during set hours" hint="Emails due outside the window wait for it to open." checked={c.delivery.sendWindow.enabled} onChange={(on) => setCfg('delivery', { sendWindow: { ...c.delivery.sendWindow, enabled: on } })} />
              {c.delivery.sendWindow.enabled && (
                <div className="grid grid-cols-1 gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_110px_110px_1fr]">
                  <Field label="Days">
                    <div className="flex flex-wrap gap-1">
                      {DAYS.map((d, i) => {
                        const on = c.delivery.sendWindow.days.includes(i);
                        return <button key={d} type="button" onClick={() => setCfg('delivery', { sendWindow: { ...c.delivery.sendWindow, days: on ? c.delivery.sendWindow.days.filter((x) => x !== i) : [...c.delivery.sendWindow.days, i].sort() } })} className={cn('h-7 w-9 rounded text-[11.5px]', on ? 'bg-fg text-inverse' : 'border border-border text-muted')}>{d}</button>;
                      })}
                    </div>
                  </Field>
                  <Field label="From"><Input type="time" value={c.delivery.sendWindow.start} onChange={(e) => setCfg('delivery', { sendWindow: { ...c.delivery.sendWindow, start: e.target.value } })} /></Field>
                  <Field label="Until"><Input type="time" value={c.delivery.sendWindow.end} onChange={(e) => setCfg('delivery', { sendWindow: { ...c.delivery.sendWindow, end: e.target.value } })} /></Field>
                  <Field label="Time zone"><Select value={c.delivery.sendWindow.timezone} onChange={(e) => setCfg('delivery', { sendWindow: { ...c.delivery.sendWindow, timezone: e.target.value } })}>{timezones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}</Select></Field>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Don’t repeat within" hint="Skip someone this endpoint already emailed (same email) recently. 0 = off.">
                <div className="flex items-center gap-2"><Input type="number" min={0} className="w-28" value={Math.round(c.delivery.dedupeMinutes / 60)} onChange={(e) => setCfg('delivery', { dedupeMinutes: Math.max(0, Math.round(Number(e.target.value) || 0)) * 60 })} /><span className="text-[12px] text-muted">hours</span></div>
              </Field>
              <Field label="Most triggers per hour" hint="Extra triggers are logged as throttled and not sent.">
                <Input type="number" min={1} className="w-32" value={c.delivery.maxTriggersPerHour} onChange={(e) => setCfg('delivery', { maxTriggersPerHour: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
              </Field>
            </div>
            <div className="flex flex-col gap-2">
              <ToggleRow label="Frequency cap per person" hint="Limit how many emails one address gets from this endpoint." checked={c.delivery.frequencyCap.enabled} onChange={(on) => setCfg('delivery', { frequencyCap: { ...c.delivery.frequencyCap, enabled: on } })} />
              {c.delivery.frequencyCap.enabled && (
                <div className="flex items-center gap-2 pl-1 text-[12.5px] text-muted">
                  At most <Input type="number" min={1} className="h-7 w-20" value={c.delivery.frequencyCap.max} onChange={(e) => setCfg('delivery', { frequencyCap: { ...c.delivery.frequencyCap, max: Math.max(1, Math.round(Number(e.target.value) || 1)) } })} />
                  emails every <Input type="number" min={1} className="h-7 w-20" value={c.delivery.frequencyCap.hours} onChange={(e) => setCfg('delivery', { frequencyCap: { ...c.delivery.frequencyCap, hours: Math.max(1, Math.round(Number(e.target.value) || 1)) } })} /> hours
                </div>
              )}
            </div>
            <Field label="Unique ID field (optional)" hint={`A repeat trigger with the same value is ignored, so retries never send twice.${v.triggerType === 'WEBHOOK' ? ' Callers can also send an Idempotency-Key header.' : ''}`}>
              <Input list="payload-paths" className="max-w-sm font-mono text-[12px]" placeholder={v.triggerType === 'WEBHOOK' ? 'orderId' : 'lead.id'} value={c.delivery.idempotencyPath} onChange={(e) => setCfg('delivery', { idempotencyPath: e.target.value.trim() })} />
            </Field>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <ToggleRow label="Track opens" checked={c.delivery.trackOpens} onChange={(on) => setCfg('delivery', { trackOpens: on })} />
              <ToggleRow label="Track link clicks" checked={c.delivery.trackClicks} onChange={(on) => setCfg('delivery', { trackClicks: on })} />
            </div>
            <div className="flex flex-col gap-2">
              <ToggleRow label="Test mode" hint="Real triggers are processed, but every email goes to the test addresses instead (subject starts with [TEST])." checked={c.delivery.testMode} onChange={(on) => setCfg('delivery', { testMode: on })} />
              {c.delivery.testMode && <Field label="Test addresses"><EmailList value={c.delivery.testRecipients} onChange={(testRecipients) => setCfg('delivery', { testRecipients })} /></Field>}
            </div>
            <Field label="Keep trigger data for" hint="After this, stored payloads and email details are erased. Delivery history stays.">
              <Select className="w-40" value={c.delivery.retentionDays} onChange={(e) => setCfg('delivery', { retentionDays: Number(e.target.value) })}>{[7, 14, 30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}</Select>
            </Field>
          </CardBody>
        </Card>

        {v.triggerType === 'WEBHOOK' && (
          <Card>
            <CardHeader title="Webhook security" description="Every call needs the endpoint’s secret token. Add these for extra protection." />
            <CardBody className="flex flex-col gap-3">
              <ToggleRow label="Require a signature" hint="Callers must sign each request body with the signing secret (HMAC-SHA256). Unsigned or replayed requests are rejected." checked={c.webhook.requireSignature} onChange={(on) => setCfg('webhook', { requireSignature: on })} />
              <Field label="Allowed IP addresses (optional)" hint="One per line; end with * for a prefix. Empty allows any address.">
                <Textarea className="font-mono text-[12px]" rows={3} value={c.webhook.ipAllowlist.join('\n')} onChange={(e) => setCfg('webhook', { ipAllowlist: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 50) })} />
              </Field>
            </CardBody>
          </Card>
        )}
        {!isNew && <div><Button variant="ghost" className="text-danger" onClick={onDelete}><Trash2 /> Delete endpoint</Button></div>}
      </div>

      <div className="flex flex-col gap-4 xl:sticky xl:top-20 xl:self-start">
        <Card>
          <CardHeader title="Variables" description="Use these in the attached emails’ subject and body." />
          <CardBody className="flex max-h-[420px] flex-col gap-0.5 overflow-y-auto">
            {autoVars.map(([k, val]) => (
              <button key={k} type="button" onClick={() => { navigator.clipboard.writeText(`{{${k}}}`); toast.success(`Copied {{${k}}}`); }} className="flex items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-surface-3">
                <span className="font-mono text-[11.5px] text-fg-2">{`{{${k}}}`}</span><span className="truncate text-[11px] text-subtle">{val}</span>
              </button>
            ))}
            <p className="mt-2 px-2 text-[11px] text-subtle">Values shown are from {v.triggerType === 'WEBHOOK' ? 'an example request' : 'a sample event'}. Every field in the trigger data is available by its name and by its full path.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Custom variables" description="Name a value from the data, with a fallback when it’s missing." />
          <CardBody className="flex flex-col gap-2">
            {c.variables.map((m, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto] gap-1.5 rounded-md border border-border p-2">
                <div className="grid gap-1.5">
                  <Input className="h-7 font-mono text-[12px]" placeholder="planName" value={m.name} onChange={(e) => set({ config: { ...c, variables: c.variables.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^A-Za-z]/g, '') } : x)) } })} aria-label="Variable name" />
                  <Input list="payload-paths" className="h-7 font-mono text-[12px]" placeholder="order.plan.name" value={m.path} onChange={(e) => set({ config: { ...c, variables: c.variables.map((x, j) => (j === i ? { ...x, path: e.target.value.trim() } : x)) } })} aria-label="Field" />
                  <Input className="h-7 text-[12px]" placeholder="Fallback (optional)" value={m.fallback} onChange={(e) => set({ config: { ...c, variables: c.variables.map((x, j) => (j === i ? { ...x, fallback: e.target.value } : x)) } })} aria-label="Fallback" />
                </div>
                <Button size="icon" variant="ghost" aria-label="Remove variable" onClick={() => set({ config: { ...c, variables: c.variables.filter((_, j) => j !== i) } })}><X /></Button>
              </div>
            ))}
            <div><Button size="sm" disabled={c.variables.length >= 50} onClick={() => set({ config: { ...c, variables: [...c.variables, { name: '', path: '', fallback: '' }] } })}><Plus /> Add variable</Button></div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={v.triggerType === 'WEBHOOK' ? 'Example request body' : 'Sample event data'} />
          <CardBody><pre className="max-h-72 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11px] leading-relaxed">{JSON.stringify(sample, null, 2)}</pre></CardBody>
        </Card>
      </div>
    </div>
  );
}

function Seg({ value, onChange, items }: { value: string; onChange: (v: string) => void; items: [string, string][] }) {
  return (
    <div className="flex flex-wrap items-center self-start rounded-md border border-border bg-surface p-0.5">
      {items.map(([k, label]) => <button key={k} type="button" onClick={() => onChange(k)} className={cn('h-7 rounded px-3 text-[12px] whitespace-nowrap', value === k ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{label}</button>)}
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <span><span className="block text-[12.5px]">{label}</span>{hint && <span className="block text-[11.5px] text-subtle">{hint}</span>}</span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}

/** Comma/newline separated addresses, parsed when the field loses focus. */
function EmailList({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Input value={text ?? value.join(', ')} placeholder="name@company.com, other@company.com" onChange={(e) => setText(e.target.value)}
      onBlur={() => { if (text !== null) { onChange([...new Set(text.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))]); setText(null); } }} />
  );
}

// ── Trigger log ────────────────────────────────────────────────────

type TriggerRow = { id: string; source: string; status: string; reason: string | null; idempotencyKey: string | null; payload: unknown; recipients: number; messages: number; ip: string | null; replayOfId: string | null; createdAt: string };
const TRIGGER_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = { ACCEPTED: 'ok', FILTERED: 'neutral', DUPLICATE: 'neutral', THROTTLED: 'warn', PAUSED: 'warn', NO_RECIPIENTS: 'warn', REJECTED: 'danger' };

function TriggerLog({ id }: { id: string }) {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<TriggerRow | null>(null);
  const { data, error } = useApiQuery<{ total: number; rows: TriggerRow[] }>(`/api/v1/email/endpoints/${id}/events?page=${page}&pageSize=50${status ? `&status=${status}` : ''}`, { refetchInterval: 10_000 });
  const replay = useApiMutation((eid: string) => api<{ status: string; messages: number }>(`/api/v1/email/endpoint-events/${eid}/replay`, { method: 'POST' }), {
    success: (r) => `Replayed: ${r.status.toLowerCase()}${r.messages ? `, ${r.messages} email${r.messages === 1 ? '' : 's'} queued` : ''}`, invalidate: ['/api/v1/email/endpoints', '/api/v1/email/history'], onSuccess: () => setOpen(null),
  });
  if (error) return <ErrorState description={errorMessage(error)} />;
  return (
    <Card>
      <CardHeader title="Trigger log" description="Every event or webhook call this endpoint received, and what happened to it."
        actions={<Select className="h-7 w-40 text-[12px]" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All outcomes</option>{Object.keys(TRIGGER_TONE).map((k) => <option key={k} value={k}>{k[0] + k.slice(1).toLowerCase().replace('_', ' ')}</option>)}</Select>} />
      {!data ? <Skeleton className="h-64" /> : (
        <SimpleTable rows={data.rows} empty="Nothing yet. Triggers appear here as they arrive." onRowClick={(r) => setOpen(r)}
          columns={[
            { key: 'createdAt', header: 'When', render: (r) => <span title={fmtDateTime(r.createdAt)}>{fmtAgo(r.createdAt)}</span> },
            { key: 'source', header: 'Source', render: (r) => <span className="text-muted">{r.source.toLowerCase()}{r.replayOfId ? ' (replay)' : ''}</span> },
            { key: 'status', header: 'Outcome', render: (r) => <Badge tone={TRIGGER_TONE[r.status] ?? 'neutral'}>{r.status[0] + r.status.slice(1).toLowerCase().replace('_', ' ')}</Badge> },
            { key: 'reason', header: 'Detail', render: (r) => <span className="block max-w-[280px] truncate text-[12px] text-muted" title={r.reason ?? ''}>{r.reason ?? (r.messages ? `${r.recipients} recipient${r.recipients === 1 ? '' : 's'} · ${r.messages} email${r.messages === 1 ? '' : 's'}` : '—')}</span> },
            { key: 'ip', header: 'IP', render: (r) => <span className="font-mono text-[11px] text-subtle">{r.ip ?? '—'}</span> },
          ]} />
      )}
      {data && data.total > 50 && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2 text-[12px] text-muted">
          <Button size="sm" variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
          Page {page} of {Math.ceil(data.total / 50)}
          <Button size="sm" variant="ghost" disabled={page * 50 >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      )}
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)} width="lg" title="Trigger" description={open ? `${open.source.toLowerCase()} · ${fmtDateTime(open.createdAt)}` : undefined}
        footer={open && open.payload !== null ? <div className="flex justify-end"><Button variant="primary" loading={replay.isPending} onClick={() => replay.mutate(open.id)}><RotateCcw /> Replay</Button></div> : undefined}>
        {open && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2"><Badge tone={TRIGGER_TONE[open.status] ?? 'neutral'}>{open.status}</Badge>{open.idempotencyKey && <span className="font-mono text-[11px] text-subtle">key: {open.idempotencyKey}</span>}</div>
            {open.reason && <p className="text-[12.5px] text-muted">{open.reason}</p>}
            <div className="eyebrow">Data received</div>
            {open.payload === null ? <p className="text-[12.5px] text-subtle">Erased by the retention policy.</p> : <pre className="max-h-[480px] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11px] leading-relaxed">{JSON.stringify(open.payload, null, 2)}</pre>}
            <p className="text-[11.5px] text-subtle">Replaying sends again with this data, ignoring the unique ID check.</p>
          </div>
        )}
      </Drawer>
    </Card>
  );
}

// ── Webhook ────────────────────────────────────────────────────────

function Copyable({ value, mono = true }: { value: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
      <span className={cn('min-w-0 flex-1 truncate text-[12px]', mono && 'font-mono')}>{value}</span>
      <Button size="icon" variant="ghost" aria-label="Copy" onClick={() => { navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? <Check /> : <Copy />}</Button>
    </div>
  );
}

function WebhookPanel({ ep, requireSignature, onSecrets }: { ep: Saved; requireSignature: boolean; onSecrets: (s: Secrets) => void }) {
  const [rotate, setRotate] = useState<'token' | 'signing' | null>(null);
  const [lang, setLang] = useState<'curl' | 'node' | 'python'>('curl');
  const url = ep.webhookUrl ?? '';
  const body = JSON.stringify(WEBHOOK_SAMPLE);
  const code = {
    curl: `curl -X POST '${url}' \\\n  -H 'Authorization: Bearer YOUR_TOKEN' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: order-A-1042' \\\n  -d '${body}'`,
    node: `const body = JSON.stringify(${body});\n${requireSignature ? `const t = Math.floor(Date.now() / 1000);\nconst sig = require('crypto').createHmac('sha256', process.env.SIGNING_SECRET).update(\`\${t}.\${body}\`).digest('hex');\n` : ''}\nawait fetch('${url}', {\n  method: 'POST',\n  headers: {\n    Authorization: \`Bearer \${process.env.ENDPOINT_TOKEN}\`,\n    'Content-Type': 'application/json',\n    'Idempotency-Key': 'order-A-1042',${requireSignature ? "\n    'X-Markeetor-Signature': `t=${t},v1=${sig}`," : ''}\n  },\n  body,\n});`,
    python: `import json, os, time, hmac, hashlib, requests\n\nbody = json.dumps(${body})\nheaders = {\n    "Authorization": f"Bearer {os.environ['ENDPOINT_TOKEN']}",\n    "Content-Type": "application/json",\n    "Idempotency-Key": "order-A-1042",\n}\n${requireSignature ? `t = str(int(time.time()))\nsig = hmac.new(os.environ["SIGNING_SECRET"].encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()\nheaders["X-Markeetor-Signature"] = f"t={t},v1={sig}"\n` : ''}requests.post("${url}", data=body, headers=headers, timeout=10)`,
  }[lang];
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><Webhook className="size-4" />Connection</span>} />
        <CardBody className="flex flex-col gap-3">
          <Field label="URL (POST)"><Copyable value={url} /></Field>
          <Field label="Secret token" hint="Send as “Authorization: Bearer <token>” (or an X-Endpoint-Token header). Shown in full only when created or rotated.">
            <div className="flex items-center gap-2"><div className="flex-1"><Copyable value={ep.tokenPreview ?? '—'} /></div><Button onClick={() => setRotate('token')}><KeyRound /> Rotate</Button></div>
          </Field>
          {requireSignature && (
            <Field label="Signing secret" hint="Sign each request: X-Markeetor-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of “t.body”>. Requests older than 5 minutes are rejected.">
              <div className="flex items-center gap-2"><div className="flex-1"><Copyable value={ep.hasSigningSecret ? 'whsec_••••••••' : 'Save the endpoint to create one'} /></div>{ep.hasSigningSecret && <Button onClick={() => setRotate('signing')}><KeyRound /> Rotate</Button>}</div>
            </Field>
          )}
          <div className="eyebrow mt-1">Responses</div>
          <SimpleTable rows={[
            { code: '202', meaning: 'Received: accepted, filtered by conditions, or no recipient (see “status”)' },
            { code: '200', meaning: 'Duplicate: this Idempotency-Key / unique ID was already received' },
            { code: '400 / 415', meaning: 'Body is not a JSON object' },
            { code: '401', meaning: 'Wrong token or invalid signature' },
            { code: '403', meaning: 'Caller IP is not on the allowlist' },
            { code: '413', meaning: 'Body larger than 256 KB' },
            { code: '423', meaning: 'Endpoint is paused' },
            { code: '429', meaning: 'Hourly trigger limit reached' },
          ]} columns={[{ key: 'code', header: 'Status', render: (r) => <span className="font-mono text-[11.5px]">{r.code}</span> }, { key: 'meaning', header: 'Meaning', render: (r) => <span className="text-muted">{r.meaning}</span> }]} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Code" actions={<Seg value={lang} onChange={(x) => setLang(x as typeof lang)} items={[['curl', 'cURL'], ['node', 'Node.js'], ['python', 'Python']]} />} />
        <CardBody>
          <pre className="overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11px] leading-relaxed whitespace-pre">{code}</pre>
          <p className="mt-2 text-[11.5px] text-subtle">Any JSON object works. Point the endpoint’s email field at wherever your data keeps the address.</p>
        </CardBody>
      </Card>
      <ConfirmDialog open={!!rotate} onOpenChange={(o) => !o && setRotate(null)} danger title={rotate === 'token' ? 'Rotate the secret token?' : 'Rotate the signing secret?'}
        description="The current value stops working immediately. Update every system that calls this endpoint." confirmLabel="Rotate"
        onConfirm={async () => { const r = await api<Secrets>(`/api/v1/email/endpoints/${ep.id}/secret`, { body: { kind: rotate } }); onSecrets(r); }} />
    </div>
  );
}

function SecretsDialog({ secrets, onClose }: { secrets: Secrets; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Save these secrets now" description="They are shown only once. If you lose them, rotate them from the Webhook tab." footer={<Button variant="primary" onClick={onClose}>I’ve saved them</Button>}>
      <div className="flex flex-col gap-3">
        {secrets.token && <Field label="Secret token"><Copyable value={secrets.token} /></Field>}
        {secrets.signingSecret && <Field label="Signing secret"><Copyable value={secrets.signingSecret} /></Field>}
      </div>
    </Dialog>
  );
}

// ── Test ───────────────────────────────────────────────────────────

function TestDialog({ id, sample, onClose }: { id: string; sample: Record<string, unknown>; onClose: () => void }) {
  const [to, setTo] = useState('');
  const [payload, setPayload] = useState(JSON.stringify(sample, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ status: string; reason?: string | null; results: { to: string; step: number; status: string; detail?: string }[] } | null>(null);
  const run = async () => {
    setError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return setError('The test data is not valid JSON');
    }
    setBusy(true);
    try {
      const recipients = to.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
      setResult(await api(`/api/v1/email/endpoints/${id}/test`, { body: { payload: parsed, ...(recipients.length ? { to: recipients } : {}) } }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title="Send a test" description="Sends every attached email right now (ignoring delays, conditions and limits) with [TEST] in the subject."
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" loading={busy} onClick={run}><FlaskConical /> Send test</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Send to" hint="Leave empty to send to yourself."><Input value={to} placeholder="you@company.com" onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Test data (JSON)"><Textarea rows={10} className="font-mono text-[11.5px]" value={payload} onChange={(e) => setPayload(e.target.value)} /></Field>
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
        {result && (
          <div className="flex flex-col gap-1.5 rounded-md border border-border p-3">
            <div className="text-[12.5px]">Outcome: <strong>{result.status.toLowerCase()}</strong>{result.reason ? ` · ${result.reason}` : ''}</div>
            {result.results.map((r, i) => <div key={i} className="flex items-center gap-2 text-[12px]"><StatusBadge status={r.status} /><span className="font-mono text-[11.5px]">{r.to}</span><span className="text-subtle">email {r.step + 1}</span>{r.detail && <span className="truncate text-muted" title={r.detail}>{r.detail}</span>}</div>)}
          </div>
        )}
      </div>
    </Dialog>
  );
}
