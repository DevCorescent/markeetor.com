'use client';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, CheckCircle2, Copy, Gift, KeyRound, Plus, Rocket, Send, ShieldAlert, Shuffle, Trash2, Wallet, Webhook, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/overlay';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtDateTime, fmtInt } from '@/lib/format';
import type { WorkspaceAutomation } from '@/lib/growth';
import { useApiQuery } from '@/lib/hooks';

// ── Getting started ────────────────────────────────────────────────

type Checklist = { steps: { key: string; title: string; hint: string; done: boolean; href: string }[]; done: number; total: number };

export function GettingStarted() {
  const { data } = useApiQuery<Checklist>('/api/v1/crm/checklist');
  const [hidden, setHidden] = useState(true);
  useEffect(() => { try { setHidden(localStorage.getItem('lcrm:checklist-hidden') === '1'); } catch { setHidden(false); } }, []);
  if (!data || hidden || data.done === data.total) return null;
  const hide = () => { try { localStorage.setItem('lcrm:checklist-hidden', '1'); } catch { /* private mode */ } setHidden(true); };
  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border bg-gradient-to-r from-accent-dim via-surface to-info-dim px-4 py-3">
        <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-info text-white"><Rocket className="size-4" /></span>
        <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium">Get the most out of your workspace</div><div className="text-[11.5px] text-subtle">{data.done} of {data.total} done</div></div>
        <div className="hidden h-1.5 w-40 overflow-hidden rounded-full bg-surface-3 sm:block"><div className="h-full rounded-full bg-gradient-to-r from-accent to-info" style={{ width: `${(data.done / data.total) * 100}%` }} /></div>
        <button type="button" onClick={hide} aria-label="Hide" className="rounded p-1 text-subtle hover:bg-surface-3 hover:text-fg"><X className="size-4" /></button>
      </div>
      <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
        {data.steps.map((s) => (
          <Link key={s.key} href={s.href} className={cn('group flex items-start gap-3 bg-surface px-4 py-3 hover:bg-surface-2', s.done && 'opacity-60')}>
            <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border', s.done ? 'border-ok bg-ok text-white' : 'border-border-strong')}>{s.done && <Check className="size-3" strokeWidth={3} />}</span>
            <div className="min-w-0 flex-1"><div className={cn('text-[12.5px] font-medium', s.done && 'line-through')}>{s.title}</div><div className="text-[11.5px] text-subtle">{s.hint}</div></div>
            {!s.done && <ArrowRight className="mt-0.5 size-3.5 text-subtle opacity-0 transition-opacity group-hover:opacity-100" />}
          </Link>
        ))}
      </div>
    </Card>
  );
}

// ── Referrals ──────────────────────────────────────────────────────

type Referral = { enabled: boolean; code: string; link: string; rewards: { you: number; friend: number }; earned: number; referrals: { id: string; name: string; status: string; createdAt: string; rewardedAt: string | null }[] };

export function ReferralCard() {
  const { data } = useApiQuery<Referral>('/api/v1/crm/referral');
  if (!data?.enabled) return null;
  const copy = async () => { await navigator.clipboard?.writeText(data.link); toast.success('Invite link copied'); };
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 bg-gradient-to-br from-ok-dim via-surface to-surface px-4 py-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ok text-white"><Gift className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">Refer a business, earn {fmtInt(data.rewards.you)} credits</div>
          <p className="mt-0.5 text-[12px] text-muted">They get {fmtInt(data.rewards.friend)} bonus credits too — paid out when they make their first purchase.</p>
        </div>
      </div>
      <CardBody className="flex flex-col gap-3">
        <div className="flex gap-2"><Input readOnly value={data.link} className="font-mono text-[12px]" aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} /><Button onClick={copy}><Copy /> Copy</Button></div>
        <div className="flex items-center gap-4 text-[12px]"><span className="text-muted">Code <b className="font-mono text-fg">{data.code}</b></span><span className="text-muted">{fmtInt(data.referrals.length)} referred</span><span className="font-medium text-ok">{fmtInt(data.earned)} credits earned</span></div>
        {data.referrals.length > 0 && (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border text-[12.5px]">
            {data.referrals.slice(0, 5).map((r) => <li key={r.id} className="flex items-center justify-between px-3 py-2"><span>{r.name}</span><span className={r.status === 'REWARDED' ? 'text-ok' : 'text-subtle'}>{r.status === 'REWARDED' ? `Rewarded ${fmtAgo(r.rewardedAt!)}` : 'Waiting for first purchase'}</span></li>)}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

// ── Reported leads (client) ────────────────────────────────────────

type Dispute = { id: string; code: string; clientLeadId: string; reasonLabel: string; status: string; refundCredits: number; resolution: string | null; createdAt: string; reporter: string | null; request: string | null };

export function MyReports() {
  const { data } = useApiQuery<{ total: number; open: number; rows: Dispute[] }>('/api/v1/disputes?page=1&pageSize=20');
  if (!data || !data.total) return null;
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><ShieldAlert className="size-4 text-warn" />Reported leads</span>} description="Lead quality guarantee — approved reports are refunded in credits." />
      <ul className="flex flex-col divide-y divide-border">
        {data.rows.map((d) => (
          <li key={d.id}>
            <Link href={`/app/leads/${d.clientLeadId}`} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px] hover:bg-surface-2">
              <span className="font-mono text-[11.5px] text-subtle">{d.code}</span>
              <span className="min-w-0 flex-1 truncate">{d.reasonLabel}{d.resolution ? <span className="text-subtle"> · {d.resolution}</span> : null}</span>
              {d.status === 'APPROVED' && <span className="tnum text-ok">+{fmtInt(d.refundCredits)} credits</span>}
              <StatusBadge status={d.status === 'OPEN' ? 'PENDING' : d.status} />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Workspace automation (Settings) ────────────────────────────────

type Member = { id: string; name: string };
type Delivery = { id: string; url: string; event: string; status: string; attempts: number; responseCode: number | null; error: string | null; createdAt: string };

export function AutomationSettings() {
  const qc = useQueryClient();
  const { data } = useApiQuery<{ automation: WorkspaceAutomation }>('/api/v1/crm/automation');
  const facets = useApiQuery<{ members: Member[] }>('/api/v1/crm/leads/facets');
  const deliveries = useApiQuery<{ total: number; rows: Delivery[] }>('/api/v1/crm/automation/deliveries?page=1');
  const [a, setA] = useState<WorkspaceAutomation | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  useEffect(() => { if (data) setA(data.automation); }, [data]);
  if (!a) return <Skeleton className="h-96" />;
  const members = facets.data?.members ?? [];
  const dirty = JSON.stringify(a) !== JSON.stringify(data?.automation);
  const aa = a.autoAssign;
  const setAA = (p: Partial<WorkspaceAutomation['autoAssign']>) => setA({ ...a, autoAssign: { ...aa, ...p } });
  const save = async () => {
    setSaving(true);
    try {
      await api('/api/v1/crm/automation', { method: 'PUT', body: a });
      toast.success('Automation saved');
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/crm/automation') });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const addHook = async () => {
    const { secret } = await api<{ secret: string }>('/api/v1/crm/automation/secret');
    setA({ ...a, webhooks: [...a.webhooks, { id: `wh${Date.now().toString(36)}`, url: '', events: ['leads.delivered'], secret, active: true }] });
  };
  const test = async (id: string) => {
    setTesting(id);
    try {
      const r = await api<{ status: string; responseCode: number | null; error: string | null }>(`/api/v1/crm/automation/webhooks/${id}/test`, { method: 'POST' });
      if (r.status === 'DELIVERED') toast.success(`Delivered (HTTP ${r.responseCode})`); else toast.error(`Failed: ${r.error ?? 'unknown error'}`);
      await deliveries.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setTesting(null);
    }
  };
  return (
    <div className="flex flex-col gap-4 pb-16">
      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-md bg-info-dim text-info"><Shuffle className="size-3.5" /></span>Auto-assignment</span>} description="Give every newly delivered lead an owner instantly." />
        <CardBody className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {([['off', 'Off', 'Leads arrive unassigned'], ['round_robin', 'Round-robin', 'Rotate evenly across the team'], ['rules', 'By rules', 'Match industry or region to a rep']] as const).map(([k, l, h]) => (
              <button key={k} type="button" onClick={() => setAA({ mode: k })} className={cn('rounded-lg border px-3 py-2.5 text-left', aa.mode === k ? 'border-fg bg-surface-2' : 'border-border hover:border-border-strong')}>
                <div className="text-[13px] font-medium">{l}</div><div className="text-[11.5px] text-subtle">{h}</div>
              </button>
            ))}
          </div>
          {aa.mode !== 'off' && (
            <Field label="Rotation pool" hint="Empty = everyone who can own leads">
              <div className="flex flex-wrap gap-1.5">
                {members.map((m) => {
                  const on = aa.memberIds.includes(m.id);
                  return <button key={m.id} type="button" onClick={() => setAA({ memberIds: on ? aa.memberIds.filter((x) => x !== m.id) : [...aa.memberIds, m.id] })} className={cn('rounded-full border px-2.5 py-1 text-[12px]', on ? 'border-info/40 bg-info-dim text-info' : 'border-border text-muted')}>{on && <Check className="mr-1 inline size-3" />}{m.name}</button>;
                })}
              </div>
            </Field>
          )}
          {aa.mode === 'rules' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between"><span className="eyebrow">Rules · first match wins</span><Button size="xs" variant="ghost" onClick={() => setAA({ rules: [...aa.rules, { field: 'industry', values: [], ownerId: members[0]?.id ?? '' }] })}><Plus /> Rule</Button></div>
              {aa.rules.map((r, i) => {
                const up = (p: Partial<typeof r>) => setAA({ rules: aa.rules.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-[12.5px]">
                    <span className="text-muted">If</span>
                    <Select className="h-8 w-32" value={r.field} onChange={(e) => up({ field: e.target.value as typeof r.field })} aria-label="Field">{['industry', 'state', 'country', 'city', 'source'].map((f) => <option key={f} value={f}>{f[0].toUpperCase() + f.slice(1)}</option>)}</Select>
                    <span className="text-muted">is</span>
                    <Input className="h-8 min-w-[180px] flex-1" placeholder="Solar, Real Estate" value={r.values.join(', ')} onChange={(e) => up({ values: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} aria-label="Values" />
                    <span className="text-muted">→</span>
                    <Select className="h-8 w-44" value={r.ownerId} onChange={(e) => up({ ownerId: e.target.value })} aria-label="Owner">{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
                    <Button size="xs" variant="ghost" aria-label="Remove" onClick={() => setAA({ rules: aa.rules.filter((_, j) => j !== i) })}><Trash2 /></Button>
                  </div>
                );
              })}
              <label className="flex items-center gap-2 text-[12.5px] text-muted"><Switch checked={aa.fallback} onCheckedChange={(v) => setAA({ fallback: v })} aria-label="Fallback" />Use round-robin when no rule matches</label>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-md bg-warn-dim text-warn"><Wallet className="size-3.5" /></span>Spending limits</span>} description="Limits for members without workspace-admin rights. 0 = no limit." />
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Max credits per request"><Input type="number" min={0} value={a.spending.maxCreditsPerRequest} onChange={(e) => setA({ ...a, spending: { ...a.spending, maxCreditsPerRequest: Math.max(0, Math.round(Number(e.target.value))) } })} /></Field>
          <Field label="Credits per member per month"><Input type="number" min={0} value={a.spending.monthlyCreditsPerUser} onChange={(e) => setA({ ...a, spending: { ...a.spending, monthlyCreditsPerUser: Math.max(0, Math.round(Number(e.target.value))) } })} /></Field>
          <Field label="Max invoice amount per request"><Input type="number" min={0} value={a.spending.maxAmountPerRequest} onChange={(e) => setA({ ...a, spending: { ...a.spending, maxAmountPerRequest: Math.max(0, Number(e.target.value)) } })} /></Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-md bg-accent-dim text-accent"><Webhook className="size-3.5" /></span>Webhooks</span>} description="Send events to Zapier, Make, Google Sheets or your own CRM. Each request is signed (header X-LeadsCRM-Signature: t=…,v1=HMAC-SHA256 of “t.body”)." actions={<Button size="sm" onClick={addHook}><Plus /> Add webhook</Button>} />
        <CardBody className="flex flex-col gap-3">
          {a.webhooks.map((w, i) => {
            const up = (p: Partial<typeof w>) => setA({ ...a, webhooks: a.webhooks.map((x, j) => (j === i ? { ...x, ...p } : x)) });
            return (
              <div key={w.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
                <div className="flex gap-2"><Input placeholder="https://hooks.zapier.com/…" value={w.url} onChange={(e) => up({ url: e.target.value.trim() })} aria-label="Webhook URL" /><Switch checked={w.active} onCheckedChange={(v) => up({ active: v })} aria-label="Active" /></div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(['leads.delivered', 'lead.status_changed', 'dispute.decided'] as const).map((ev) => {
                    const on = w.events.includes(ev);
                    return <button key={ev} type="button" onClick={() => up({ events: on ? w.events.filter((x) => x !== ev) : [...w.events, ev] })} className={cn('rounded-full border px-2.5 py-0.5 font-mono text-[11px]', on ? 'border-accent/40 bg-accent-dim text-accent' : 'border-border text-subtle')}>{ev}</button>;
                  })}
                  <span className="ml-auto flex items-center gap-1 text-[11px] text-subtle"><KeyRound className="size-3" /><code className="max-w-[160px] truncate">{w.secret}</code><button type="button" onClick={() => { void navigator.clipboard?.writeText(w.secret); toast.success('Signing secret copied'); }} aria-label="Copy secret"><Copy className="size-3" /></button></span>
                </div>
                <div className="flex gap-2">
                  <Button size="xs" loading={testing === w.id} disabled={dirty} onClick={() => test(w.id)}><Send /> Send test</Button>
                  <Button size="xs" variant="ghost" onClick={() => setA({ ...a, webhooks: a.webhooks.filter((_, j) => j !== i) })}><Trash2 /> Remove</Button>
                  {dirty && <span className="text-[11px] text-subtle">Save to test</span>}
                </div>
              </div>
            );
          })}
          {!a.webhooks.length && <p className="text-[12px] text-subtle">No webhooks yet.</p>}
          {(deliveries.data?.rows.length ?? 0) > 0 && (
            <div>
              <div className="eyebrow mb-1.5">Recent deliveries</div>
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border text-[12px]">
                {deliveries.data!.rows.slice(0, 10).map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                    {d.status === 'DELIVERED' ? <CheckCircle2 className="size-3.5 text-ok" /> : <X className="size-3.5 text-danger" />}
                    <span className="font-mono">{d.event}</span><span className="min-w-0 flex-1 truncate text-subtle">{d.url}</span>
                    <span className="text-subtle">{d.responseCode ? `HTTP ${d.responseCode}` : d.error ?? d.status.toLowerCase()}</span><span className="text-subtle">{fmtDateTime(d.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardBody>
      </Card>

      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur lg:left-[232px]">
          <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-2.5 md:px-6">
            <span className="text-[12.5px] text-muted">Unsaved automation changes</span>
            {a.webhooks.some((w) => !w.url.startsWith('https://')) && <InlineNotice tone="warn" className="py-1">Webhook URLs must start with https://</InlineNotice>}
            <Button variant="ghost" className="ml-auto" onClick={() => setA(data!.automation)}>Discard</Button>
            <Button variant="primary" loading={saving} disabled={a.webhooks.some((w) => !w.url.startsWith('https://'))} onClick={save}>Save automation</Button>
          </div>
        </div>
      )}
    </div>
  );
}
