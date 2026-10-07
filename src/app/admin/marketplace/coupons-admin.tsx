'use client';
import { Plus, Shuffle, Ticket, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { MultiFilter } from '@/components/data/quick-filters';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Drawer, Switch } from '@/components/ui/overlay';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtDate, fmtDateTime, fmtInt } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { couponLabel, money } from '@/lib/pricing';

type Coupon = {
  id: string; code: string; name: string; description: string | null; type: 'PERCENT' | 'FIXED' | 'FREE_LEADS'; value: number; maxDiscount: number | null; minLeads: number; minSubtotal: number;
  startsAt: string | null; endsAt: string | null; maxRedemptions: number | null; perClientLimit: number; organizationIds: string[]; visibleToClients: boolean; firstRequestOnly: boolean; active: boolean;
  redemptionCount: number; discountGiven: number; freeLeadsGiven: number; createdAt: string;
};
type Form = Omit<Coupon, 'id' | 'redemptionCount' | 'discountGiven' | 'freeLeadsGiven' | 'createdAt'>;
const blank = (): Form => ({ code: '', name: '', description: '', type: 'PERCENT', value: 10, maxDiscount: null, minLeads: 0, minSubtotal: 0, startsAt: null, endsAt: null, maxRedemptions: null, perClientLimit: 1, organizationIds: [], visibleToClients: true, firstRequestOnly: false, active: true });
const randomCode = () => `LEADS${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
/** ISO → value for <input type=datetime-local> in the admin's own timezone. */
const toLocal = (d: string | null) => { if (!d) return ''; const x = new Date(d); return new Date(x.getTime() - x.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

function state(c: Coupon) {
  const now = Date.now();
  if (!c.active) return { label: 'Inactive', tone: 'dim' as const };
  if (c.startsAt && new Date(c.startsAt).getTime() > now) return { label: 'Scheduled', tone: 'neutral' as const };
  if (c.endsAt && new Date(c.endsAt).getTime() <= now) return { label: 'Expired', tone: 'dim' as const };
  if (c.maxRedemptions != null && c.redemptionCount >= c.maxRedemptions) return { label: 'Used up', tone: 'warn' as const };
  return { label: 'Active', tone: 'ok' as const };
}

export function CouponsAdmin() {
  const { data, refetch } = useApiQuery<{ coupons: Coupon[] }>('/api/v1/coupons');
  const pricing = useApiQuery<{ pricing: { currency: string } }>('/api/v1/marketplace/pricing');
  const orgs = useApiQuery<{ orgs: { id: string; name: string }[] }>('/api/v1/leads/facets');
  const cur = pricing.data?.pricing.currency ?? 'USD';
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [del, setDel] = useState<Coupon | null>(null);
  const [usage, setUsage] = useState<Coupon | null>(null);

  const save = async () => {
    if (!editing) return;
    const f = editing.form;
    try {
      await api(editing.id ? `/api/v1/coupons/${editing.id}` : '/api/v1/coupons', {
        method: editing.id ? 'PUT' : 'POST',
        body: { ...f, description: f.description || null, startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : null, endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null },
      });
      toast.success(editing.id ? 'Coupon updated' : `Coupon ${f.code} created`);
      setEditing(null);
      refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[12.5px] text-muted">Visible coupons appear on client dashboards and in the request dialog; hidden ones work only when the code is shared.</p>
        <Button variant="primary" onClick={() => setEditing({ id: null, form: { ...blank(), code: randomCode() } })}><Plus /> New coupon</Button>
      </div>
      {!data ? <Skeleton className="h-48" /> : !data.coupons.length ? (
        <Card className="flex flex-col items-center gap-2 py-12 text-center">
          <Ticket className="size-6 text-subtle" /><div className="text-[13.5px] font-medium">No coupons yet</div>
          <p className="max-w-sm text-[12px] text-subtle">Create a percentage, fixed-amount or free-leads coupon to reward clients or run a promotion.</p>
          <Button className="mt-2" variant="primary" onClick={() => setEditing({ id: null, form: { ...blank(), code: randomCode() } })}><Plus /> New coupon</Button>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">{['Coupon', 'Benefit', 'Who', 'Valid', 'Used', 'Given', 'Status', ''].map((h) => <th key={h} className="h-9 px-4 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {data.coupons.map((c) => {
                  const st = state(c);
                  return (
                    <tr key={c.id} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-surface-2" onClick={() => setEditing({ id: c.id, form: { ...c, startsAt: toLocal(c.startsAt), endsAt: toLocal(c.endsAt) } })}>
                      <td className="px-4 py-2.5"><div className="font-mono text-[12px] font-semibold">{c.code}</div><div className="text-[11px] text-subtle">{c.name}{!c.visibleToClients && ' · hidden'}</div></td>
                      <td className="px-4">{couponLabel(c, cur)}{(c.minLeads > 0 || c.firstRequestOnly) && <div className="text-[11px] text-subtle">{[c.minLeads ? `min ${c.minLeads} leads` : null, c.firstRequestOnly ? 'first request' : null].filter(Boolean).join(' · ')}</div>}</td>
                      <td className="px-4 text-muted">{c.organizationIds.length ? `${c.organizationIds.length} client${c.organizationIds.length === 1 ? '' : 's'}` : 'All clients'}</td>
                      <td className="px-4 whitespace-nowrap text-muted">{c.startsAt ? fmtDate(c.startsAt) : 'Now'} – {c.endsAt ? fmtDate(c.endsAt) : 'no end'}</td>
                      <td className="tnum px-4">{fmtInt(c.redemptionCount)}{c.maxRedemptions != null && <span className="text-subtle"> / {fmtInt(c.maxRedemptions)}</span>}</td>
                      <td className="tnum px-4">{c.type === 'FREE_LEADS' ? `${fmtInt(c.freeLeadsGiven)} leads` : money(c.discountGiven * 100, cur)}</td>
                      <td className="px-4"><Badge tone={st.tone}>{st.label}</Badge></td>
                      <td className="px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <Button size="xs" variant="ghost" onClick={() => setUsage(c)}>Usage</Button>
                        <Button size="icon" variant="ghost" aria-label={`Delete ${c.code}`} onClick={() => setDel(c)}><Trash2 /></Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editing && (
        <Drawer open onOpenChange={(o) => !o && setEditing(null)} title={editing.id ? `Edit ${editing.form.code}` : 'New coupon'} description="Coupons apply after volume and account discounts, before tax." width="lg"
          footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" disabled={editing.form.code.length < 3 || editing.form.name.trim().length < 2 || !(editing.form.value > 0)} onClick={save}>{editing.id ? 'Save coupon' : 'Create coupon'}</Button></>}>
          <CouponForm f={editing.form} set={(p) => setEditing({ ...editing, form: { ...editing.form, ...p } })} orgs={orgs.data?.orgs ?? []} currency={cur} />
        </Drawer>
      )}
      {usage && <Usage coupon={usage} currency={cur} onClose={() => setUsage(null)} />}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Delete ${del?.code}`} danger confirmLabel="Delete"
        description={del?.redemptionCount ? 'This coupon has been used, so it will be deactivated instead of deleted (its history stays on invoices).' : 'The code stops working immediately.'}
        onConfirm={async () => { const r = await api<{ deactivated: boolean }>(`/api/v1/coupons/${del!.id}`, { method: 'DELETE' }); toast.success(r.deactivated ? 'Coupon deactivated' : 'Coupon deleted'); refetch(); }} />
    </>
  );
}

function CouponForm({ f, set, orgs, currency }: { f: Form; set: (p: Partial<Form>) => void; orgs: { id: string; name: string }[]; currency: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-stretch overflow-hidden rounded-xl border border-border-strong">
        <div className="flex w-2/5 flex-col justify-center bg-fg px-4 py-4 text-inverse">
          <div className="text-[22px] leading-tight font-semibold tracking-[-0.02em]">{f.value > 0 ? couponLabel(f, currency).replace(/ \(up to.*\)/, '') : '—'}</div>
          <div className="mt-1 truncate text-[11.5px] opacity-70">{f.name || 'Coupon name'}</div>
        </div>
        <div className="flex flex-1 flex-col justify-center gap-1 border-l border-dashed border-border-strong px-4 py-3 text-[12px] text-muted">
          <span className="font-mono text-[14px] font-semibold text-fg">{f.code || 'CODE'}</span>
          <span>{f.description || 'How clients see it on their dashboard'}</span>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Code"><div className="flex gap-2"><Input value={f.code} maxLength={32} onChange={(e) => set({ code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') })} className="font-mono" /><Button variant="ghost" size="icon" aria-label="Random code" onClick={() => set({ code: randomCode() })}><Shuffle /></Button></div></Field>
        <Field label="Name"><Input value={f.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="Spring promotion" /></Field>
      </div>
      <Field label="Description shown to clients (optional)"><Textarea rows={2} value={f.description ?? ''} maxLength={300} onChange={(e) => set({ description: e.target.value })} /></Field>
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-fg-2">Benefit</div>
        <div className="grid grid-cols-3 gap-2">
          {([['PERCENT', 'Percentage off'], ['FIXED', 'Fixed amount off'], ['FREE_LEADS', 'Free leads']] as const).map(([t, l]) => (
            <button key={t} type="button" onClick={() => set({ type: t, value: t === 'PERCENT' ? 10 : t === 'FIXED' ? 25 : 5 })} className={cn('rounded-lg border px-3 py-2 text-left text-[12.5px]', f.type === t ? 'border-fg ring-1 ring-fg' : 'border-border hover:border-border-strong')}>{l}</button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label={f.type === 'PERCENT' ? 'Percent off' : f.type === 'FIXED' ? `Amount off (${currency})` : 'Free leads'}><Input type="number" min={1} max={f.type === 'PERCENT' ? 100 : undefined} value={f.value} onChange={(e) => set({ value: Number(e.target.value) })} /></Field>
        {f.type === 'PERCENT' && <Field label={`Max discount (${currency}, optional)`}><Input type="number" min={0} value={f.maxDiscount ?? ''} onChange={(e) => set({ maxDiscount: e.target.value ? Number(e.target.value) : null })} /></Field>}
        <Field label="Minimum leads"><Input type="number" min={0} value={f.minLeads} onChange={(e) => set({ minLeads: Math.max(0, Math.round(Number(e.target.value))) })} /></Field>
        {f.type !== 'FREE_LEADS' && <Field label={`Minimum order (${currency})`}><Input type="number" min={0} value={f.minSubtotal} onChange={(e) => set({ minSubtotal: Math.max(0, Number(e.target.value)) })} /></Field>}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Starts (optional)"><Input type="datetime-local" value={f.startsAt ?? ''} onChange={(e) => set({ startsAt: e.target.value || null })} /></Field>
        <Field label="Ends (optional)"><Input type="datetime-local" value={f.endsAt ?? ''} onChange={(e) => set({ endsAt: e.target.value || null })} /></Field>
        <Field label="Total uses (blank = unlimited)"><Input type="number" min={1} value={f.maxRedemptions ?? ''} onChange={(e) => set({ maxRedemptions: e.target.value ? Math.round(Number(e.target.value)) : null })} /></Field>
        <Field label="Uses per client"><Input type="number" min={1} value={f.perClientLimit} onChange={(e) => set({ perClientLimit: Math.max(1, Math.round(Number(e.target.value))) })} /></Field>
      </div>
      <Field label="Clients">
        <div className="flex flex-wrap items-center gap-2">
          <MultiFilter label={f.organizationIds.length ? 'Selected clients' : 'All clients'} field="org" options={orgs.map((o) => ({ value: o.id, label: o.name }))} conditions={f.organizationIds.length ? [{ field: 'org', op: 'in', value: f.organizationIds }] : []} onChange={(cs) => set({ organizationIds: (cs.find((c) => c.field === 'org')?.value as string[] | undefined) ?? [] })} />
          {f.organizationIds.map((id) => <Badge key={id} tone="outline">{orgs.find((o) => o.id === id)?.name ?? id}</Badge>)}
        </div>
      </Field>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {([['visibleToClients', 'Show on client dashboards'], ['firstRequestOnly', 'First request only'], ['active', 'Active']] as const).map(([k, l]) => (
          <label key={k} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[12.5px]">{l}<Switch checked={f[k]} onCheckedChange={(v) => set({ [k]: v } as Partial<Form>)} aria-label={l} /></label>
        ))}
      </div>
      {f.type === 'FREE_LEADS' && <InlineNotice>Free-lead coupons add to the client’s demo allowance for this request and cover the highest-priced leads after it.</InlineNotice>}
    </div>
  );
}

function Usage({ coupon, currency, onClose }: { coupon: Coupon; currency: string; onClose: () => void }) {
  const { data } = useApiQuery<{ redemptions: { id: string; organization: string; discount: number; extraFreeLeads: number; createdAt: string; request: { code: string; status: string } | null }[] }>(`/api/v1/coupons/${coupon.id}/redemptions`);
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={`${coupon.code} usage`} description={`${fmtInt(coupon.redemptionCount)} redemption${coupon.redemptionCount === 1 ? '' : 's'}`} width="md">
      {!data ? <Skeleton className="h-40" /> : !data.redemptions.length ? <div className="py-10 text-center text-[12.5px] text-subtle">Not used yet.</div> : (
        <table className="w-full text-[12.5px]">
          <thead><tr className="text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase"><th className="py-2">Client</th><th>Request</th><th className="text-right">Benefit</th><th className="text-right">When</th></tr></thead>
          <tbody>
            {data.redemptions.map((r) => (
              <tr key={r.id} className="border-t border-border/60">
                <td className="py-2">{r.organization}</td>
                <td>{r.request ? <span className="flex items-center gap-1.5"><span className="font-mono text-[11.5px]">{r.request.code}</span><StatusBadge status={r.request.status} /></span> : '—'}</td>
                <td className="tnum text-right">{r.extraFreeLeads ? `${r.extraFreeLeads} free leads` : money(r.discount * 100, currency)}</td>
                <td className="text-right text-subtle">{fmtDateTime(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Drawer>
  );
}
