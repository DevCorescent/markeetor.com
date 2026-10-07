'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Pencil, Plus, Trash2, Truck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtInt } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';
import { money } from '@/lib/pricing';

type S = {
  id: string; name: string; status: string; sources: string[]; costPerLead: number; currency: string; contactName: string | null; email: string | null; phone: string | null; notes: string | null;
  imported: number; available: number; sold: number; revenue: number; cost: number; profit: number; margin: number | null; sellThrough: number; reportRate: number; winRate: number; quality: number; disputes: number; invalid: number; won: number;
};
type Perf = { suppliers: S[]; unassigned: { source: string; imported: number; available: number; sold: number; revenue: number }[] };
type Draft = { name: string; contactName: string; email: string; phone: string; sources: string; costPerLead: string; currency: string; status: string; notes: string };

const STATUS_TONE: Record<string, string> = { ACTIVE: 'bg-ok-dim text-ok', PAUSED: 'bg-warn-dim text-warn', BLOCKED: 'bg-danger-dim text-danger' };

export function SuppliersView() {
  const qc = useQueryClient();
  const [s, set] = useUrlState({ days: '30' });
  const { data } = useApiQuery<Perf>(`/api/v1/suppliers?days=${s.days}`);
  const [edit, setEdit] = useState<{ id: string | null; d: Draft } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/suppliers') });
  const open = (x: S | null, preset?: string) => setEdit({ id: x?.id ?? null, d: { name: x?.name ?? '', contactName: x?.contactName ?? '', email: x?.email ?? '', phone: x?.phone ?? '', sources: x?.sources.join(', ') ?? preset ?? '', costPerLead: String(x?.costPerLead ?? 0), currency: x?.currency ?? 'INR', status: x?.status ?? 'ACTIVE', notes: x?.notes ?? '' } });
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      const d = edit.d;
      await api(edit.id ? `/api/v1/suppliers/${edit.id}` : '/api/v1/suppliers', { method: edit.id ? 'PUT' : 'POST', body: { name: d.name, contactName: d.contactName || null, email: d.email || null, phone: d.phone || null, sources: d.sources.split(',').map((x) => x.trim()).filter(Boolean), costPerLead: Number(d.costPerLead) || 0, currency: d.currency, status: d.status, notes: d.notes || null } });
      toast.success('Supplier saved');
      setEdit(null); await refresh();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast.success(msg); await refresh(); } catch (e) { toast.error(errorMessage(e)); } };
  const totals = (data?.suppliers ?? []).reduce((a, x) => ({ revenue: a.revenue + x.revenue, cost: a.cost + x.cost, profit: a.profit + x.profit, sold: a.sold + x.sold }), { revenue: 0, cost: 0, profit: 0, sold: 0 });
  const cur = data?.suppliers[0]?.currency ?? 'INR';
  const m = (x: number) => money(Math.round(x * 100), cur);
  return (
    <>
      <PageHeader eyebrow="Lead operations" title="Suppliers" description="Who supplies your leads, what they cost, and which sources make money. Leads are matched to a supplier by their source."
        actions={<div className="flex gap-2"><Select className="h-8 w-36 text-[12.5px]" value={s.days} onChange={(e) => set({ days: e.target.value })} aria-label="Period">{[['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select><Button variant="primary" onClick={() => open(null)}><Plus /> Add supplier</Button></div>} />
      {!data ? <Skeleton className="h-96" /> : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            {([['Revenue', m(totals.revenue), 'text-fg'], ['Lead cost', m(totals.cost), 'text-muted'], ['Profit', m(totals.profit), totals.profit >= 0 ? 'text-ok' : 'text-danger'], ['Leads sold', fmtInt(totals.sold), 'text-info']] as const).map(([k, v, t]) => <Card key={k} className="px-4 py-3.5"><div className="eyebrow">{k}</div><div className={cn('tnum mt-2 text-[22px] font-semibold', t)}>{v}</div></Card>)}
          </div>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-[12.5px]">
                <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">{['Supplier', 'Leads in', 'Sold', 'Sell-through', 'Revenue', 'Cost', 'Profit', 'Reports', 'Win rate', 'Quality', ''].map((h) => <th key={h} className="h-9 px-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {data.suppliers.map((x) => (
                    <tr key={x.id} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2.5"><div className="flex items-center gap-2"><span className="font-medium">{x.name}</span><span className={cn('rounded-full px-1.5 text-[10px] font-medium', STATUS_TONE[x.status])}>{x.status.toLowerCase()}</span></div><div className="max-w-[220px] truncate text-[11px] text-subtle">{x.sources.join(', ') || 'No sources mapped'} · {m(x.costPerLead)}/lead</div></td>
                      <td className="tnum px-3">{fmtInt(x.imported)}</td>
                      <td className="tnum px-3">{fmtInt(x.sold)} <span className="text-subtle">/ {fmtInt(x.available)} left</span></td>
                      <td className="tnum px-3">{x.sellThrough}%</td>
                      <td className="tnum px-3">{m(x.revenue)}</td>
                      <td className="tnum px-3 text-muted">{m(x.cost)}</td>
                      <td className={cn('tnum px-3 font-medium', x.profit >= 0 ? 'text-ok' : 'text-danger')}>{m(x.profit)}{x.margin != null && <span className="block text-[10.5px] font-normal text-subtle">{x.margin}% margin</span>}</td>
                      <td className={cn('tnum px-3', x.reportRate > 10 ? 'font-medium text-danger' : '')}>{x.reportRate}%<span className="block text-[10.5px] text-subtle">{x.disputes} reports</span></td>
                      <td className="tnum px-3">{x.winRate}%</td>
                      <td className="px-3"><span className={cn('tnum rounded-full px-2 py-0.5 text-[11px] font-semibold', x.quality >= 70 ? 'bg-ok-dim text-ok' : x.quality >= 40 ? 'bg-warn-dim text-warn' : 'bg-danger-dim text-danger')}>{x.quality}</span></td>
                      <td className="px-3 text-right whitespace-nowrap">
                        <Button size="xs" variant="ghost" onClick={() => open(x)} aria-label="Edit"><Pencil /></Button>
                        {x.available > 0 && <Button size="xs" variant="ghost" aria-label="Pull unsold stock" onClick={() => confirm(`Archive ${x.available} unsold leads from ${x.name}? They leave the marketplace.`) && act(() => api(`/api/v1/suppliers/${x.id}/pull`, { method: 'POST' }), 'Unsold stock archived')}><Archive /></Button>}
                        <Button size="xs" variant="ghost" aria-label="Delete" onClick={() => confirm(`Delete ${x.name}? Leads are kept.`) && act(() => api(`/api/v1/suppliers/${x.id}`, { method: 'DELETE' }), 'Supplier deleted')}><Trash2 /></Button>
                      </td>
                    </tr>
                  ))}
                  {!data.suppliers.length && <tr><td colSpan={11} className="py-10 text-center text-subtle"><Truck className="mx-auto mb-2 size-5" />No suppliers yet — add one and map the lead sources it supplies.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
          {data.unassigned.length > 0 && (
            <Card>
              <CardHeader title="Sources without a supplier" description="Map them to see cost and profit." />
              <ul className="flex flex-col divide-y divide-border">
                {data.unassigned.map((u) => <li key={u.source} className="flex items-center gap-3 px-4 py-2 text-[12.5px]"><span className="min-w-0 flex-1 truncate font-medium">{u.source}</span><span className="text-subtle">{fmtInt(u.imported)} in · {fmtInt(u.sold)} sold · {fmtInt(u.available)} available</span><span className="tnum w-24 text-right">{m(u.revenue)}</span>{u.source !== '(no source)' && <Button size="xs" variant="outline" onClick={() => open(null, u.source)}><Plus /> Supplier</Button>}</li>)}
              </ul>
            </Card>
          )}
        </div>
      )}
      {edit && (
        <Dialog open onOpenChange={(o) => !o && setEdit(null)} title={edit.id ? 'Edit supplier' : 'Add supplier'} size="lg"
          footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={edit.d.name.trim().length < 2} onClick={save}>Save</Button></>}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={edit.d.name} onChange={(e) => setEdit({ ...edit, d: { ...edit.d, name: e.target.value } })} autoFocus /></Field>
            <Field label="Status"><Select value={edit.d.status} onChange={(e) => setEdit({ ...edit, d: { ...edit.d, status: e.target.value } })}><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option><option value="BLOCKED">Blocked</option></Select></Field>
            <Field label="Lead sources" hint="Comma-separated `source` values of its leads" className="sm:col-span-2"><Input value={edit.d.sources} onChange={(e) => setEdit({ ...edit, d: { ...edit.d, sources: e.target.value } })} placeholder="Facebook Ads, Vendor X" /></Field>
            <Field label="Cost per lead"><Input type="number" min={0} step={0.01} value={edit.d.costPerLead} onChange={(e) => setEdit({ ...edit, d: { ...edit.d, costPerLead: e.target.value } })} /></Field>
            <Field label="Currency"><Select value={edit.d.currency} onChange={(e) => setEdit({ ...edit, d: { ...edit.d, currency: e.target.value } })}>{['INR', 'USD', 'EUR', 'GBP', 'AED'].map((c) => <option key={c}>{c}</option>)}</Select></Field>
            <Field label="Contact name"><Input value={edit.d.contactName} onChange={(e) => setEdit({ ...edit, d: { ...edit.d, contactName: e.target.value } })} /></Field>
            <Field label="Email"><Input value={edit.d.email} onChange={(e) => setEdit({ ...edit, d: { ...edit.d, email: e.target.value } })} /></Field>
            <Field label="Phone"><Input value={edit.d.phone} onChange={(e) => setEdit({ ...edit, d: { ...edit.d, phone: e.target.value } })} /></Field>
            <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={edit.d.notes} onChange={(e) => setEdit({ ...edit, d: { ...edit.d, notes: e.target.value } })} /></Field>
          </div>
        </Dialog>
      )}
    </>
  );
}
