'use client';
import { Download, Play, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { BarList, ColumnChart } from '@/components/data/charts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Dialog } from '@/components/ui/overlay';
import { InlineNotice } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { api, errorMessage } from '@/lib/api-client';
import { fmtAgo, fmtInt } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';

const METRICS: Record<string, string> = { leads_imported: 'Leads imported', leads_allocated: 'Leads allocated', contacted: 'Leads contacted', converted: 'Leads converted', lost: 'Leads lost', comms_logged: 'Contact attempts logged' };
const DIMS: Record<string, string> = { day: 'Day', week: 'Week', source: 'Source', campaign: 'Campaign', organization: 'Client organization', industry: 'Industry', country: 'Country' };
type Def = { metric: string; groupBy: string; rangeDays: number; sources: string[]; campaigns: string[]; orgIds: string[] };
type Saved = { id: string; name: string; definition: Def; schedule: string | null; recipients: string[]; lastRunAt: string | null };

/** Custom report builder over whitelisted metrics × dimensions. Workspace mode hides platform-only metrics and the organization dimension. */
export function ReportBuilder({ workspace, canExport }: { workspace?: boolean; canExport?: boolean }) {
  const metrics = Object.entries(METRICS).filter(([k]) => !workspace || !['leads_imported', 'leads_allocated'].includes(k));
  const dims = Object.entries(DIMS).filter(([k]) => !workspace || k !== 'organization');
  const [def, setDef] = useState<Def>({ metric: workspace ? 'converted' : 'leads_allocated', groupBy: workspace ? 'week' : 'organization', rangeDays: 30, sources: [], campaigns: [], orgIds: [] });
  const [rows, setRows] = useState<{ label: string; value: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const saved = useApiQuery<{ reports: Saved[] }>('/api/v1/reports');
  const del = useApiMutation((id: string) => api(`/api/v1/reports/${id}`, { method: 'DELETE' }), { success: 'Report deleted', invalidate: ['/api/v1/reports'] });

  const run = async (d = def) => {
    setBusy(true);
    setError(null);
    try {
      setRows((await api<{ rows: { label: string; value: number }[] }>('/api/v1/analytics/report', { body: d })).rows);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const exportCsv = async () => {
    try {
      const res = await api<Response>('/api/v1/analytics/export', { body: def, raw: true });
      const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `report-${def.metric}-by-${def.groupBy}.csv`; a.click();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const timeDim = def.groupBy === 'day' || def.groupBy === 'week';

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
      <Card>
        <CardHeader title="Custom report" description={workspace ? 'Aggregated figures for your workspace only' : 'Aggregated figures — no lead-level data'} actions={
          <div className="flex gap-1.5">
            {rows && <Button size="sm" variant="ghost" onClick={() => setSaveOpen(true)}><Save /> Save</Button>}
            {rows && canExport && !workspace && <Button size="sm" variant="ghost" onClick={exportCsv}><Download /> CSV</Button>}
          </div>
        } />
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Metric" className="w-52"><Select value={def.metric} onChange={(e) => setDef({ ...def, metric: e.target.value })}>{metrics.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Group by" className="w-44"><Select value={def.groupBy} onChange={(e) => setDef({ ...def, groupBy: e.target.value })}>{dims.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Period" className="w-36"><Select value={def.rangeDays} onChange={(e) => setDef({ ...def, rangeDays: Number(e.target.value) })}>{[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}</Select></Field>
            <Button variant="primary" loading={busy} onClick={() => run()}><Play /> Run</Button>
          </div>
          {error && <InlineNotice tone="danger">{error}</InlineNotice>}
          {rows && (rows.length === 0 ? <div className="py-10 text-center text-xs text-subtle">No data for this report</div> : timeDim ? (
            <ColumnChart data={rows} xKey="label" yKey="value" label={METRICS[def.metric]} height={240} />
          ) : (
            <BarList items={rows.slice(0, 25).map((r) => ({ label: r.label, value: r.value }))} />
          ))}
          {rows && rows.length > 0 && (
            <details className="text-xs text-subtle"><summary className="cursor-pointer">Table view ({rows.length} rows)</summary>
              <SimpleTable rows={rows.map((r, i) => ({ ...r, id: i }))} columns={[{ key: 'label', header: DIMS[def.groupBy] }, { key: 'value', header: METRICS[def.metric], className: 'tnum text-right', render: (r) => fmtInt(r.value) }]} className="mt-2" />
            </details>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Saved reports" />
        <ul>
          {!saved.data?.reports.length && <li className="px-4 py-5 text-xs text-subtle">No saved reports</li>}
          {saved.data?.reports.map((r) => (
            <li key={r.id} className="group flex items-center gap-2 border-b border-border/60 px-4 py-2 last:border-0">
              <button className="min-w-0 flex-1 text-left" onClick={() => { setDef(r.definition); run(r.definition); }}>
                <div className="truncate text-[12.5px]">{r.name}</div>
                <div className="text-[11px] text-subtle">{METRICS[r.definition.metric]} by {DIMS[r.definition.groupBy]?.toLowerCase()}{r.schedule && <> · <Badge tone="outline">{r.schedule.toLowerCase()}</Badge></>}{r.lastRunAt && ` · sent ${fmtAgo(r.lastRunAt)}`}</div>
              </button>
              <button className="p-1 text-subtle opacity-0 hover:text-fg group-hover:opacity-100" aria-label={`Delete ${r.name}`} onClick={() => del.mutate(r.id)}><Trash2 className="size-3.5" /></button>
            </li>
          ))}
        </ul>
      </Card>
      {saveOpen && <SaveReport def={def} onClose={() => setSaveOpen(false)} />}
    </div>
  );
}

function SaveReport({ def, onClose }: { def: Def; onClose: () => void }) {
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [recipients, setRecipients] = useState('');
  const save = useApiMutation(() => api('/api/v1/reports', { body: { name, definition: def, schedule: schedule || null, recipients: recipients.split(',').map((r) => r.trim()).filter(Boolean) } }), { success: 'Report saved', invalidate: ['/api/v1/reports'], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Save report" size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={name.trim().length < 2} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Schedule (optional)"><Select value={schedule} onChange={(e) => setSchedule(e.target.value)}><option value="">Not scheduled</option><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></Select></Field>
        {schedule && <Field label="Recipients" hint="Comma-separated emails of active users in your organization. Reports contain aggregates only."><Input value={recipients} onChange={(e) => setRecipients(e.target.value)} /></Field>}
      </div>
    </Dialog>
  );
}
