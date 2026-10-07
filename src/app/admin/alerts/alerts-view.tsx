'use client';
import { useQueryClient } from '@tanstack/react-query';
import { BellRing, Eye, Mail, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Dialog, Switch } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { ALERT_METRICS, type AlertMetric } from '@/lib/finance';
import { fmtAgo } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';

type Rule = { id: string; name: string; metric: AlertMetric; threshold: number; params: { industry?: string }; cooldownHours: number; email: boolean; active: boolean; lastFiredAt: string | null };
type Ev = { id: string; title: string; body: string; createdAt: string; rule: { name: string } };
type Draft = Omit<Rule, 'id' | 'lastFiredAt'>;

const PRESETS: Draft[] = [
  { name: 'Client low on credits', metric: 'client_credits_below', threshold: 100, params: {}, cooldownHours: 72, email: true, active: true },
  { name: 'Marketplace stock low', metric: 'stock_below', threshold: 200, params: {}, cooldownHours: 24, email: true, active: true },
  { name: 'Lead request waiting', metric: 'pending_request_hours', threshold: 2, params: {}, cooldownHours: 24, email: false, active: true },
  { name: 'Credit payment waiting', metric: 'pending_credit_hours', threshold: 24, params: {}, cooldownHours: 24, email: false, active: true },
  { name: 'Supplier quality problem', metric: 'supplier_report_rate', threshold: 10, params: {}, cooldownHours: 168, email: true, active: true },
  { name: 'Client at risk', metric: 'client_health_below', threshold: 40, params: {}, cooldownHours: 168, email: false, active: true },
];

export function AlertsView() {
  const qc = useQueryClient();
  const { data } = useApiQuery<{ rules: Rule[]; events: Ev[] }>('/api/v1/alert-rules', { refetchInterval: 60_000 });
  const [edit, setEdit] = useState<{ id: string | null; d: Draft } | null>(null);
  const [preview, setPreview] = useState<{ title: string; body: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/alert-rules') });
  const save = async (id: string | null, d: Draft) => {
    setBusy(true);
    try { await api(id ? `/api/v1/alert-rules/${id}` : '/api/v1/alert-rules', { method: id ? 'PUT' : 'POST', body: d }); toast.success('Alert rule saved'); setEdit(null); await refresh(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const test = async (d: Draft) => {
    try { setPreview((await api<{ hits: { title: string; body: string }[] }>('/api/v1/alert-rules/preview', { body: d })).hits); } catch (e) { toast.error(errorMessage(e)); }
  };
  const meta = (k: AlertMetric) => ALERT_METRICS.find((m) => m.key === k)! as { key: AlertMetric; label: string; unit: string; hint?: string };
  const unused = PRESETS.filter((p) => !data?.rules.some((r) => r.metric === p.metric));
  return (
    <>
      <PageHeader eyebrow="Operations" title="Alert rules" description="Get notified (in the bell, and by email if you choose) when something needs attention. Checked every 15 minutes; each client, supplier or request alerts once per cooldown."
        actions={<Button variant="primary" onClick={() => setEdit({ id: null, d: { ...PRESETS[0], name: 'New alert' } })}><Plus /> New rule</Button>} />
      {!data ? <Skeleton className="h-96" /> : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-3">
            {data.rules.map((r) => {
              const m = meta(r.metric);
              return (
                <Card key={r.id} className={cn('flex items-center gap-3 p-4', !r.active && 'opacity-55')}>
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-warn-dim text-warn"><BellRing className="size-4" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13.5px] font-medium">{r.name}{r.email && <Mail className="size-3.5 text-accent" />}</div>
                    <div className="text-[12px] text-muted">{m.label} <b className="tnum text-fg">{r.threshold.toLocaleString()}</b> {m.unit === 'currency' ? '' : m.unit}{r.params.industry ? ` · ${r.params.industry}` : ''}</div>
                    <div className="text-[11px] text-subtle">{r.lastFiredAt ? `Last alert ${fmtAgo(r.lastFiredAt)}` : 'Hasn’t fired yet'} · repeats after {r.cooldownHours}h</div>
                  </div>
                  <Switch checked={r.active} onCheckedChange={(v) => save(r.id, { ...r, active: v })} aria-label="Active" />
                  <Button size="xs" variant="ghost" aria-label="Edit" onClick={() => setEdit({ id: r.id, d: { name: r.name, metric: r.metric, threshold: r.threshold, params: r.params ?? {}, cooldownHours: r.cooldownHours, email: r.email, active: r.active } })}><Pencil /></Button>
                  <Button size="xs" variant="ghost" aria-label="Delete" onClick={async () => { try { await api(`/api/v1/alert-rules/${r.id}`, { method: 'DELETE' }); await refresh(); } catch (e) { toast.error(errorMessage(e)); } }}><Trash2 /></Button>
                </Card>
              );
            })}
            {unused.length > 0 && (
              <Card className="p-4">
                <div className="eyebrow mb-2">Suggested rules</div>
                <div className="flex flex-wrap gap-2">{unused.map((p) => <Button key={p.metric} size="sm" variant="outline" onClick={() => save(null, p)}><Plus /> {p.name}</Button>)}</div>
              </Card>
            )}
          </div>
          <Card className="self-start">
            <CardHeader title="Recent alerts" />
            <ul className="flex max-h-[600px] flex-col divide-y divide-border overflow-y-auto">
              {data.events.map((e) => <li key={e.id} className="px-4 py-2.5"><div className="flex items-baseline justify-between gap-2"><span className="text-[12.5px] font-medium">{e.title}</span><span className="text-[11px] text-subtle">{fmtAgo(e.createdAt)}</span></div><div className="text-[11.5px] text-subtle">{e.rule.name} · {e.body}</div></li>)}
              {!data.events.length && <li className="px-4 py-8 text-center text-[12.5px] text-subtle">No alerts yet.</li>}
            </ul>
          </Card>
        </div>
      )}
      {edit && (
        <Dialog open onOpenChange={(o) => { if (!o) { setEdit(null); setPreview(null); } }} title={edit.id ? 'Edit alert rule' : 'New alert rule'} size="md"
          footer={<><Button variant="ghost" onClick={() => test(edit.d)}><Eye /> Check now</Button><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={edit.d.name.trim().length < 2} onClick={() => save(edit.id, edit.d)}>Save</Button></>}>
          <div className="flex flex-col gap-3">
            <Field label="Name"><Input value={edit.d.name} onChange={(e) => setEdit({ ...edit, d: { ...edit.d, name: e.target.value } })} /></Field>
            <Field label="Alert when" hint={meta(edit.d.metric).hint}><Select value={edit.d.metric} onChange={(e) => { setPreview(null); setEdit({ ...edit, d: { ...edit.d, metric: e.target.value as AlertMetric } }); }}>{ALERT_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label} …</option>)}</Select></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Threshold (${meta(edit.d.metric).unit})`}><Input type="number" min={0} value={edit.d.threshold} onChange={(e) => setEdit({ ...edit, d: { ...edit.d, threshold: Math.max(0, Number(e.target.value)) } })} /></Field>
              <Field label="Repeat after (hours)"><Input type="number" min={1} max={720} value={edit.d.cooldownHours} onChange={(e) => setEdit({ ...edit, d: { ...edit.d, cooldownHours: Math.max(1, Math.round(Number(e.target.value))) } })} /></Field>
            </div>
            {edit.d.metric === 'stock_below' && <Field label="Industry (optional)"><Input value={edit.d.params.industry ?? ''} onChange={(e) => setEdit({ ...edit, d: { ...edit.d, params: { industry: e.target.value || undefined } } })} placeholder="All industries" /></Field>}
            <label className="flex items-center justify-between gap-3 text-[12.5px]"><span>Also email the marketplace team</span><Switch checked={edit.d.email} onCheckedChange={(v) => setEdit({ ...edit, d: { ...edit.d, email: v } })} aria-label="Email" /></label>
            {preview && (preview.length ? <InlineNotice tone="warn"><b className="font-medium">{preview.length} would alert now:</b> {preview.slice(0, 5).map((p) => p.title).join(' · ')}</InlineNotice> : <InlineNotice>Nothing would alert right now.</InlineNotice>)}
          </div>
        </Dialog>
      )}
    </>
  );
}
