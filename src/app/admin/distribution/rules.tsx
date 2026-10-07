'use client';
import { Pencil, Play, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { FilterBuilder } from '@/components/data/filter-builder';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Checkbox, Drawer, Switch } from '@/components/ui/overlay';
import { EmptyState, InlineNotice } from '@/components/ui/states';
import { api } from '@/lib/api-client';
import type { Condition } from '@/lib/filters';
import { fmtAgo, humanize } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { leadFields } from '../leads/lead-repository';
import { STRATEGY_INFO } from './strategies';

type Rule = { id: string; name: string; description: string | null; strategy: string; trigger: string; intervalMinutes: number | null; enabled: boolean; version: number; lastRunAt: string | null; lastBatchId: string | null; config: { filter: { conditions: Condition[] }; targets: { organizationId: string; weight?: number }[]; maxPerRun: number; respectQuotas: boolean; includeInvalid: boolean } };
const RULE_STRATEGIES = ['ROUND_ROBIN', 'WEIGHTED', 'QUOTA', 'CAPACITY', 'GEOGRAPHY', 'INDUSTRY', 'CAMPAIGN', 'SCORE'];

export function RulesPanel() {
  const { data } = useApiQuery<{ rules: Rule[] }>('/api/v1/distribution/rules');
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [del, setDel] = useState<Rule | null>(null);
  const run = useApiMutation((id: string) => api<{ message: string }>(`/api/v1/distribution/rules/${id}/run`, { method: 'POST' }), { success: (r) => r.message, invalidate: ['/api/v1/distribution'] });
  const remove = useApiMutation((id: string) => api(`/api/v1/distribution/rules/${id}`, { method: 'DELETE' }), { success: 'Rule deleted', invalidate: ['/api/v1/distribution/rules'] });
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="max-w-2xl text-xs text-subtle">Rules select unallocated, valid leads matching a filter and allocate them with a strategy. Triggers: manual, on a schedule, or whenever an import completes. Only clients that accept automated distribution are eligible; quotas and auto-pause apply.</p>
        <Button variant="primary" onClick={() => setEditing('new')}><Plus /> New rule</Button>
      </div>
      {!data?.rules.length ? <Card><EmptyState title="No automated rules" description="Create a rule to allocate new leads automatically." /></Card> : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {data.rules.map((r) => (
            <Card key={r.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-3 px-4 pt-3.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><span className="truncate text-[13.5px] font-medium">{r.name}</span><Badge tone={r.enabled ? 'ok' : 'dim'} dot>{r.enabled ? 'Enabled' : 'Disabled'}</Badge></div>
                  <p className="mt-0.5 text-xs text-subtle">{r.description || STRATEGY_INFO[r.strategy]?.description}</p>
                </div>
                <span className="font-mono text-[10.5px] text-subtle">v{r.version}</span>
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-1 px-4 py-3 text-[11.5px] text-muted">
                <span>{STRATEGY_INFO[r.strategy]?.label}</span>
                <span>{r.trigger === 'SCHEDULED' ? `Every ${r.intervalMinutes} min` : humanize(r.trigger)}</span>
                <span>Max {r.config.maxPerRun}/run</span>
                <span>{r.config.targets.length ? `${r.config.targets.length} clients` : 'All accepting clients'}</span>
                <span>{r.config.filter.conditions.length} condition(s)</span>
                <span>Last run {r.lastRunAt ? fmtAgo(r.lastRunAt) : 'never'}{r.lastBatchId && <> · <Link className="underline" href={`/admin/distribution/batches/${r.lastBatchId}`}>batch</Link></>}</span>
              </div>
              <div className="mt-auto flex justify-end gap-1 border-t border-border px-3 py-2">
                <Button size="sm" variant="ghost" onClick={() => setDel(r)} disabled={r.enabled}><Trash2 /> Delete</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Pencil /> Edit</Button>
                <Button size="sm" onClick={() => run.mutate(r.id)} loading={run.isPending && run.variables === r.id}><Play /> Run now</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing && <RuleEditor rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Delete rule “${del?.name}”`} danger confirmLabel="Delete" onConfirm={() => remove.mutateAsync(del!.id)} />
    </>
  );
}

function RuleEditor({ rule, onClose }: { rule: Rule | null; onClose: () => void }) {
  const facets = useApiQuery<Parameters<typeof leadFields>[0] & { orgs: { id: string; name: string }[] }>('/api/v1/leads/facets');
  const [f, setF] = useState({
    name: rule?.name ?? '', description: rule?.description ?? '', strategy: rule?.strategy ?? 'ROUND_ROBIN', trigger: rule?.trigger ?? 'MANUAL',
    intervalMinutes: rule?.intervalMinutes ?? 60, enabled: rule?.enabled ?? false,
    conditions: rule?.config.filter.conditions ?? [], targets: rule?.config.targets ?? [], maxPerRun: rule?.config.maxPerRun ?? 500,
    respectQuotas: rule?.config.respectQuotas ?? true, includeInvalid: rule?.config.includeInvalid ?? false,
  });
  const save = useApiMutation(
    () => api(rule ? `/api/v1/distribution/rules/${rule.id}` : '/api/v1/distribution/rules', {
      method: rule ? 'PUT' : 'POST',
      body: { name: f.name, description: f.description || null, strategy: f.strategy, trigger: f.trigger, intervalMinutes: f.trigger === 'SCHEDULED' ? f.intervalMinutes : null, enabled: f.enabled, config: { filter: { conditions: f.conditions }, targets: f.targets, maxPerRun: f.maxPerRun, respectQuotas: f.respectQuotas, includeInvalid: f.includeInvalid } },
    }),
    { success: 'Rule saved', invalidate: ['/api/v1/distribution/rules'], onSuccess: onClose },
  );
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={rule ? `Edit rule · v${rule.version}` : 'New distribution rule'} width="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={f.name.trim().length < 2} onClick={() => save.mutate(undefined)}>Save rule</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Description"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Strategy"><Select value={f.strategy} onChange={(e) => setF({ ...f, strategy: e.target.value })}>{RULE_STRATEGIES.map((s) => <option key={s} value={s}>{STRATEGY_INFO[s].label}</option>)}</Select></Field>
          <Field label="Trigger"><Select value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })}><option value="MANUAL">Manual only</option><option value="SCHEDULED">Scheduled</option><option value="ON_IMPORT">When an import completes</option></Select></Field>
          {f.trigger === 'SCHEDULED' && <Field label="Interval (minutes)"><Input type="number" min={5} value={f.intervalMinutes} onChange={(e) => setF({ ...f, intervalMinutes: Number(e.target.value) })} /></Field>}
          <Field label="Max leads per run"><Input type="number" min={1} max={50000} value={f.maxPerRun} onChange={(e) => setF({ ...f, maxPerRun: Number(e.target.value) })} /></Field>
        </div>
        <p className="text-[11.5px] text-subtle">{STRATEGY_INFO[f.strategy]?.description}</p>
        <Field label="Lead filter" hint="Unallocated and valid are always added automatically"><FilterBuilder fields={leadFields(facets.data ?? undefined)} value={f.conditions} onChange={(c) => setF({ ...f, conditions: c })} /></Field>
        <Field label="Target clients" hint="Leave empty to include every active client that accepts automated distribution">
          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-border-strong p-2">
            {facets.data?.orgs.map((o) => {
              const t = f.targets.find((x) => x.organizationId === o.id);
              return (
                <div key={o.id} className="flex items-center gap-2 text-[12.5px]">
                  <Checkbox checked={Boolean(t)} aria-label={o.name} onCheckedChange={(c) => setF({ ...f, targets: c ? [...f.targets, { organizationId: o.id }] : f.targets.filter((x) => x.organizationId !== o.id) })} />
                  <span className="flex-1 truncate">{o.name}</span>
                  {t && f.strategy === 'WEIGHTED' && <Input type="number" min={0} className="h-6 w-16" value={t.weight ?? 1} onChange={(e) => setF({ ...f, targets: f.targets.map((x) => (x.organizationId === o.id ? { ...x, weight: Number(e.target.value) } : x)) })} aria-label="Weight" />}
                </div>
              );
            })}
          </div>
        </Field>
        <div className="flex flex-col gap-2.5 text-[12.5px]">
          <label className="flex items-center justify-between">Respect client quotas<Switch checked={f.respectQuotas} onCheckedChange={(v) => setF({ ...f, respectQuotas: v })} /></label>
          <label className="flex items-center justify-between">Include invalid leads<Switch checked={f.includeInvalid} onCheckedChange={(v) => setF({ ...f, includeInvalid: v })} /></label>
          <label className="flex items-center justify-between">Enabled<Switch checked={f.enabled} onCheckedChange={(v) => setF({ ...f, enabled: v })} /></label>
        </div>
        {f.enabled && f.trigger !== 'MANUAL' && <InlineNotice tone="warn">This rule will allocate leads automatically without further confirmation.</InlineNotice>}
      </div>
    </Drawer>
  );
}
