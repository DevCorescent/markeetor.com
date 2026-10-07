'use client';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, CreditCard, FileText, Landmark } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { TaxInvoiceDialog, type TaxInvoice } from '@/components/finance/tax-invoice';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Switch, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { financialYear, GST_STATES, stateFromGstin, type FinanceSettings } from '@/lib/finance';
import { fmtDate, fmtInt } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';
import { money } from '@/lib/pricing';

function Settings() {
  const qc = useQueryClient();
  const { data } = useApiQuery<{ settings: FinanceSettings; razorpay: { configured: boolean; webhook: boolean } }>('/api/v1/finance/settings');
  const [f, setF] = useState<FinanceSettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) setF(data.settings); }, [data]);
  if (!f || !data) return <Skeleton className="h-96" />;
  const dirty = JSON.stringify(f) !== JSON.stringify(data.settings);
  const seller = (p: Partial<FinanceSettings['seller']>) => setF({ ...f, seller: { ...f.seller, ...p } });
  const save = async () => {
    setSaving(true);
    try { await api('/api/v1/finance/settings', { method: 'PUT', body: f }); toast.success('Finance settings saved'); await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/finance') }); }
    catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  const rz = data.razorpay;
  return (
    <div className="flex flex-col gap-4 pb-16">
      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><Landmark className="size-4 text-info" />Your business (seller)</span>} description="Printed on every invoice. The GST state decides CGST+SGST (same state as the client) or IGST." />
        <CardBody className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Legal name"><Input value={f.seller.legalName} onChange={(e) => seller({ legalName: e.target.value })} /></Field>
          <Field label="GSTIN" hint={f.seller.gstin && stateFromGstin(f.seller.gstin) ? `Registered in ${stateFromGstin(f.seller.gstin)}` : 'Optional'}><Input value={f.seller.gstin} maxLength={15} className="font-mono uppercase" onChange={(e) => seller({ gstin: e.target.value.toUpperCase(), state: stateFromGstin(e.target.value.toUpperCase()) ?? f.seller.state })} /></Field>
          <Field label="PAN"><Input value={f.seller.pan} maxLength={10} className="font-mono uppercase" onChange={(e) => seller({ pan: e.target.value.toUpperCase() })} /></Field>
          <Field label="State"><Select value={f.seller.state} onChange={(e) => seller({ state: e.target.value })}><option value="">—</option>{Object.values(GST_STATES).sort().map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="Billing email"><Input value={f.seller.email} onChange={(e) => seller({ email: e.target.value })} /></Field>
          <Field label="Phone"><Input value={f.seller.phone} onChange={(e) => seller({ phone: e.target.value })} /></Field>
          <Field label="Registered address" className="md:col-span-3"><Textarea rows={2} value={f.seller.address} onChange={(e) => seller({ address: e.target.value })} /></Field>
        </CardBody>
      </Card>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><FileText className="size-4 text-accent" />Invoices</span>} description="Issued automatically for credit purchases and invoiced lead purchases." actions={<Switch checked={f.invoices.enabled} onCheckedChange={(v) => setF({ ...f, invoices: { ...f.invoices, enabled: v } })} aria-label="Invoices" />} />
          <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Number prefix" hint={`e.g. ${f.invoices.prefix}/${financialYear(new Date(), f.invoices.fyStartMonth)}/0001`}><Input value={f.invoices.prefix} maxLength={10} className="font-mono uppercase" onChange={(e) => setF({ ...f, invoices: { ...f.invoices, prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '') } })} /></Field>
            <Field label="SAC code"><Input value={f.invoices.sac} maxLength={8} className="font-mono" onChange={(e) => setF({ ...f, invoices: { ...f.invoices, sac: e.target.value.replace(/\D/g, '') } })} /></Field>
            <Field label="Financial year starts"><Select value={String(f.invoices.fyStartMonth)} onChange={(e) => setF({ ...f, invoices: { ...f.invoices, fyStartMonth: Number(e.target.value) } })}>{['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select></Field>
            <Field label="Footer terms" className="sm:col-span-2"><Textarea rows={2} value={f.invoices.terms} onChange={(e) => setF({ ...f, invoices: { ...f.invoices, terms: e.target.value } })} /></Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><CreditCard className="size-4 text-ok" />Online payments (Razorpay)</span>} description="Clients pay for credit packs by card, UPI or net banking; credits are added the moment the payment succeeds." actions={<Switch checked={f.payments.razorpay} onCheckedChange={(v) => setF({ ...f, payments: { razorpay: v } })} aria-label="Razorpay" />} />
          <CardBody className="flex flex-col gap-2 text-[12.5px]">
            {[['API keys (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET)', rz.configured], ['Webhook secret (RAZORPAY_WEBHOOK_SECRET)', rz.webhook]].map(([l, ok]) => (
              <div key={String(l)} className="flex items-center gap-2">{ok ? <CheckCircle2 className="size-4 text-ok" /> : <CircleAlert className="size-4 text-warn" />}<span>{l}</span><span className={cn('ml-auto text-[11.5px]', ok ? 'text-ok' : 'text-warn')}>{ok ? 'Configured' : 'Missing'}</span></div>
            ))}
            <p className="mt-1 text-[11.5px] text-subtle">Set the keys in the server environment. In the Razorpay dashboard add a webhook to <code className="font-mono">https://&lt;your-domain&gt;/api/v1/public/razorpay/webhook</code> for <code>payment.captured</code>, <code>order.paid</code> and <code>payment.failed</code>. Use test keys first.</p>
          </CardBody>
        </Card>
      </div>
      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur lg:left-[232px]">
          <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-2.5 md:px-6"><span className="text-[12.5px] text-muted">Unsaved finance settings</span><Button variant="ghost" className="ml-auto" onClick={() => setF(data.settings)}>Discard</Button><Button variant="primary" loading={saving} onClick={save}>Save</Button></div>
        </div>
      )}
    </div>
  );
}

function Invoices() {
  const fy = financialYear(new Date());
  const [s, set] = useUrlState({ fy, page: '1' });
  const list = useApiQuery<{ total: number; rows: TaxInvoice[]; sums: { taxable: number; cgst: number; sgst: number; igst: number; total: number } }>(`/api/v1/finance/invoices?page=${s.page}&pageSize=50&fy=${s.fy}`);
  const gst = useApiQuery<{ months: { month: string; invoices: number; taxable: number; cgst: number; sgst: number; igst: number; total: number }[] }>(`/api/v1/finance/gst?fy=${s.fy}`);
  const [open, setOpen] = useState<string | null>(null);
  const cur = list.data?.rows[0]?.currency ?? 'INR';
  const m = (x: number) => money(Math.round(x * 100), cur);
  const years = Array.from({ length: 4 }, (_, i) => financialYear(new Date(new Date().getFullYear() - i, 6, 1)));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2"><Select className="h-8 w-36 text-[12.5px]" value={s.fy} onChange={(e) => set({ fy: e.target.value, page: '1' })} aria-label="Financial year">{years.map((y) => <option key={y} value={y}>FY {y}</option>)}</Select><span className="text-[12px] text-subtle">{fmtInt(list.data?.total ?? 0)} invoices</span></div>
      {list.data && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
          {([['Taxable value', list.data.sums.taxable], ['CGST', list.data.sums.cgst], ['SGST', list.data.sums.sgst], ['IGST', list.data.sums.igst], ['Invoice total', list.data.sums.total]] as const).map(([k, v]) => <Card key={k} className="px-4 py-3"><div className="eyebrow">{k}</div><div className="tnum mt-1.5 text-[18px] font-semibold">{m(v)}</div></Card>)}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Invoices" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[12.5px]">
              <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">{['Number', 'Date', 'Client', 'For', 'Taxable', 'Tax', 'Total', 'Status'].map((h) => <th key={h} className="h-9 px-3 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {(list.data?.rows ?? []).map((i) => (
                  <tr key={i.id} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-surface-2" onClick={() => setOpen(i.id)}>
                    <td className="px-3 py-2 font-mono text-[11.5px]">{i.number}</td><td className="px-3 text-muted">{fmtDate(i.issuedAt)}</td><td className="max-w-[180px] truncate px-3">{i.buyer.name}</td>
                    <td className="px-3 text-muted">{i.kind === 'CREDIT_PURCHASE' ? 'Credits' : 'Leads'}</td><td className="tnum px-3">{m(i.taxable)}</td><td className="tnum px-3 text-muted">{m(i.cgst + i.sgst + i.igst)}</td><td className="tnum px-3 font-medium">{m(i.total)}</td>
                    <td className="px-3"><span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-medium', i.paid ? 'bg-ok-dim text-ok' : 'bg-warn-dim text-warn')}>{i.paid ? 'Paid' : 'Due'}</span></td>
                  </tr>
                ))}
                {list.data && !list.data.rows.length && <tr><td colSpan={8} className="py-10 text-center text-subtle">No invoices in this financial year.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
        <Card className="self-start">
          <CardHeader title="GST summary by month" description="For your GSTR-1 / GSTR-3B filing" />
          <div className="overflow-x-auto"><table className="w-full text-[12px]"><thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">{['Month', 'Taxable', 'CGST', 'SGST', 'IGST'].map((h) => <th key={h} className="h-8 px-3 font-medium">{h}</th>)}</tr></thead>
            <tbody>{(gst.data?.months ?? []).map((r) => <tr key={r.month} className="border-b border-border/60 last:border-0"><td className="px-3 py-1.5">{r.month}</td><td className="tnum px-3">{m(r.taxable)}</td><td className="tnum px-3">{m(r.cgst)}</td><td className="tnum px-3">{m(r.sgst)}</td><td className="tnum px-3">{m(r.igst)}</td></tr>)}
              {gst.data && !gst.data.months.length && <tr><td colSpan={5} className="py-6 text-center text-subtle">Nothing yet.</td></tr>}</tbody></table></div>
        </Card>
      </div>
      {open && <TaxInvoiceDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function FinanceView() {
  const [s, set] = useUrlState({ tab: 'invoices' });
  return (
    <>
      <PageHeader eyebrow="Clients" title="Finance" description="GST invoices, filing summaries, your business details and online payments." />
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}><TabsList className="mb-4"><TabsTrigger value="invoices">Invoices & GST</TabsTrigger><TabsTrigger value="settings">Business & payments</TabsTrigger></TabsList></Tabs>
      {s.tab === 'invoices' ? <Invoices /> : <Settings />}
    </>
  );
}
