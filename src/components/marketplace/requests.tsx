'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, Check, CreditCard, Printer, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/data/data-table';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Dialog, Drawer } from '@/components/ui/overlay';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { fmtAgo, fmtDateTime, fmtInt, humanize } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { money } from '@/lib/pricing';
import { useQueryClient } from '@tanstack/react-query';

export type Req = {
  id: string; code: string; status: string; billingStatus: string; invoiceNumber: string | null; leadCount: number; deliveredCount: number; freeApplied: number;
  currency: string; subtotal: number; discount: number; tax: number; total: number; note: string | null; adminNote: string | null; createdAt: string; decidedAt: string | null; paidAt: string | null;
  organization: { name: string } | null; requester: { name: string; email: string } | null; organizationId: string;
  paymentMethod?: string; creditsCharged?: number;
};
type Detail = Req & { items: { id: string; status: string; free: boolean; price: number; lead: { ref: string; fullName?: string; country: string | null; state: string | null; industry: string | null; score: number } | null }[] };

/** Request list shared by the client ("My requests", "Invoices") and admin ("Requests") views. */
export function RequestsTable({ admin = false, billingOnly = false, organizationId }: { admin?: boolean; billingOnly?: boolean; organizationId?: string }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(admin ? 'PENDING' : '');
  const [billing, setBilling] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const url = `/api/v1/marketplace/requests?page=${page}&pageSize=25${status ? `&status=${status}` : ''}${billing ? `&billing=${billing}` : ''}${organizationId ? `&organizationId=${organizationId}` : ''}`;
  const { data, isFetching } = useApiQuery<{ total: number; rows: Req[] }>(url, { refetchInterval: 20_000 });
  const rows = (data?.rows ?? []).filter((r) => !billingOnly || r.billingStatus !== 'NONE');
  const cols: ColumnDef<Req, unknown>[] = [
    { id: 'code', header: billingOnly ? 'Invoice' : 'Request', cell: ({ row: { original: r } }) => <div><div className="font-mono text-[12px] text-fg">{billingOnly ? r.invoiceNumber ?? r.code : r.code}</div><div className="text-[11px] text-subtle">{fmtDateTime(r.createdAt)}</div></div> },
    ...(admin ? [{ id: 'org', header: 'Client', cell: ({ row: { original: r } }: { row: { original: Req } }) => <div><div>{r.organization?.name ?? '—'}</div><div className="text-[11px] text-subtle">{r.requester?.name}</div></div> }] : []),
    { id: 'leads', header: 'Leads', cell: ({ row: { original: r } }) => <span className="tnum">{['FULFILLED', 'PARTIAL'].includes(r.status) ? <>{fmtInt(r.deliveredCount)}<span className="text-subtle"> / {fmtInt(r.leadCount)}</span></> : fmtInt(r.leadCount)}{r.freeApplied > 0 && <Badge tone="ok" className="ml-1.5">{r.freeApplied} free</Badge>}</span> },
    { id: 'status', header: 'Status', cell: ({ row: { original: r } }) => <StatusBadge status={r.status} /> },
    { id: 'total', header: 'Amount', cell: ({ row: { original: r } }) => <span className="tnum font-medium">{r.total > 0 ? money(r.total * 100, r.currency) : <span className="font-normal text-subtle">Free</span>}{r.paymentMethod === 'CREDITS' && <span className="block text-[11px] font-normal text-subtle">{fmtInt(r.creditsCharged ?? 0)} credits</span>}</span> },
    { id: 'billing', header: 'Billing', cell: ({ row: { original: r } }) => (r.billingStatus === 'NONE' ? <span className="text-subtle">—</span> : <StatusBadge status={r.billingStatus} />) },
    { id: 'decided', header: 'Updated', cell: ({ row: { original: r } }) => <span className="text-subtle">{fmtAgo(r.paidAt ?? r.decidedAt ?? r.createdAt)}</span> },
  ];
  return (
    <>
      <DataTable
        columns={cols} data={rows} total={billingOnly ? rows.length : data?.total ?? 0} page={page} pageSize={25} onPage={setPage} loading={isFetching} getRowId={(r) => r.id} onRowClick={(r) => setOpen(r.id)}
        empty={<div className="py-10 text-center text-[12.5px] text-subtle">{billingOnly ? 'No invoices yet.' : 'No requests yet.'}</div>}
        toolbar={
          <div className="flex gap-2">
            {!billingOnly && <Select className="h-7 w-40 text-[12px]" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status"><option value="">All statuses</option>{['PENDING', 'FULFILLED', 'PARTIAL', 'REJECTED', 'CANCELLED'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>}
            <Select className="h-7 w-40 text-[12px]" value={billing} onChange={(e) => { setBilling(e.target.value); setPage(1); }} aria-label="Billing"><option value="">All billing</option>{['DUE', 'PAID', 'WAIVED', 'VOID', 'NONE'].map((s) => <option key={s} value={s}>{s === 'NONE' ? 'Free' : humanize(s)}</option>)}</Select>
          </div>
        }
      />
      {open && <RequestDrawer id={open} admin={admin} onClose={() => setOpen(null)} />}
    </>
  );
}

function RequestDrawer({ id, admin, onClose }: { id: string; admin: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useApiQuery<Detail>(`/api/v1/marketplace/requests/${id}`);
  const [reject, setReject] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [invoice, setInvoice] = useState(false);
  const act = async (key: string, path: string, body: unknown, msg: string) => {
    setBusy(key);
    try {
      await api(`/api/v1/marketplace/requests/${id}/${path}`, { method: 'POST', body });
      toast.success(msg);
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/marketplace') });
      setReject(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const r = data;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={r ? `Request ${r.code}` : 'Request'} description={r ? `${admin ? `${r.organization?.name ?? ''} · ` : ''}${r.requester?.name ?? ''} · ${fmtDateTime(r.createdAt)}` : ''} width="lg"
      footer={r && (
        <>
          {r.invoiceNumber && <Button variant="ghost" onClick={() => setInvoice(true)}><Printer /> Invoice</Button>}
          {!admin && r.status === 'PENDING' && <Button variant="ghost" loading={busy === 'cancel'} onClick={() => act('cancel', 'cancel', undefined, 'Request cancelled')}><X /> Cancel request</Button>}
          {admin && r.status === 'PENDING' && <><Button variant="ghost" onClick={() => setReject(true)}><Ban /> Reject</Button><Button variant="primary" loading={busy === 'approve'} onClick={() => act('approve', 'approve', {}, 'Approved — leads delivered')}><Check /> Approve & deliver</Button></>}
          {admin && r.billingStatus === 'DUE' && r.paymentMethod !== 'CREDITS' && <><Button variant="ghost" loading={busy === 'WAIVED'} onClick={() => act('WAIVED', 'billing', { status: 'WAIVED' }, 'Charge waived')}>Waive</Button><Button variant="primary" loading={busy === 'PAID'} onClick={() => act('PAID', 'billing', { status: 'PAID' }, 'Marked as paid')}><CreditCard /> Mark paid</Button></>}
          {admin && r.billingStatus === 'PAID' && r.paymentMethod !== 'CREDITS' && <Button variant="ghost" loading={busy === 'DUE'} onClick={() => act('DUE', 'billing', { status: 'DUE' }, 'Marked as due')}>Mark unpaid</Button>}
        </>
      )}>
      {!r ? <Skeleton className="h-64" /> : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Status" value={<StatusBadge status={r.status} />} />
            <Stat label="Leads" value={['FULFILLED', 'PARTIAL'].includes(r.status) ? `${fmtInt(r.deliveredCount)} of ${fmtInt(r.leadCount)} delivered` : fmtInt(r.leadCount)} />
            <Stat label="Amount" value={r.total > 0 ? money(r.total * 100, r.currency) : 'Free'} />
            <Stat label={r.paymentMethod === 'CREDITS' ? 'Paid with' : 'Billing'} value={r.paymentMethod === 'CREDITS' ? <span className="tnum">{fmtInt(r.creditsCharged ?? 0)} credits{r.status === 'PENDING' ? ' (held)' : ''}</span> : r.billingStatus === 'NONE' ? '—' : <StatusBadge status={r.billingStatus} />} />
          </div>
          {r.note && <InlineNotice><b className="font-medium">Client note:</b> {r.note}</InlineNotice>}
          {r.adminNote && <InlineNotice tone={r.status === 'REJECTED' ? 'warn' : 'neutral'}><b className="font-medium">Platform note:</b> {r.adminNote}</InlineNotice>}
          {r.total > 0 && (
            <div className="rounded-lg border border-border px-3.5 py-2.5 text-[12.5px]">
              <div className="flex justify-between text-muted"><span>Subtotal</span><span className="tnum">{money(r.subtotal * 100, r.currency)}</span></div>
              {r.discount > 0 && <div className="flex justify-between text-muted"><span>Discount</span><span className="tnum">−{money(r.discount * 100, r.currency)}</span></div>}
              {r.tax > 0 && <div className="flex justify-between text-muted"><span>Tax</span><span className="tnum">{money(r.tax * 100, r.currency)}</span></div>}
              <div className="mt-1 flex justify-between border-t border-border pt-1.5 font-medium"><span>Total{r.invoiceNumber ? ` · ${r.invoiceNumber}` : ''}</span><span className="tnum">{money(r.total * 100, r.currency)}</span></div>
            </div>
          )}
          <div>
            <div className="eyebrow mb-2">Leads in this request</div>
            <div className="max-h-[45vh] overflow-auto rounded-lg border border-border">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-surface-2"><tr className="text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase"><th className="px-3 py-2 font-medium">Lead</th><th className="px-3 py-2 font-medium">Profile</th><th className="px-3 py-2 text-right font-medium">Price</th><th className="px-3 py-2 font-medium">Status</th></tr></thead>
                <tbody>
                  {r.items.map((i) => (
                    <tr key={i.id} className="border-t border-border/60">
                      <td className="px-3 py-1.5"><span className="font-mono text-[11.5px]">{i.lead?.ref ?? '—'}</span>{admin && i.lead?.fullName && <div className="text-[11px] text-subtle">{i.lead.fullName}</div>}</td>
                      <td className="px-3 py-1.5 text-muted">{[i.lead?.industry, [i.lead?.state, i.lead?.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || '—'}{i.lead && <span className="text-subtle"> · score {i.lead.score}</span>}</td>
                      <td className="tnum px-3 py-1.5 text-right">{i.free ? <Badge tone="ok">Free</Badge> : money(i.price * 100, r.currency)}</td>
                      <td className="px-3 py-1.5"><StatusBadge status={i.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!admin && ['FULFILLED', 'PARTIAL'].includes(r.status) && <p className="mt-2 text-[11.5px] text-subtle">Delivered leads, with full contact details, are in <Link href="/app/leads?view=unassigned" className="underline underline-offset-2 hover:text-fg">My leads</Link>.</p>}
          </div>
        </div>
      )}
      <Dialog open={reject} onOpenChange={setReject} title="Reject request" description="The reserved leads go back to the marketplace and the client is notified with your reason."
        footer={<><Button variant="ghost" onClick={() => setReject(false)}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={busy === 'reject'} onClick={() => act('reject', 'reject', { reason }, 'Request rejected')}>Reject</Button></>}>
        <Field label="Reason"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </Dialog>
      {r && invoice && <Invoice r={r} onClose={() => setInvoice(false)} />}
    </Drawer>
  );
}

const Stat = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="rounded-lg border border-border px-3 py-2"><div className="eyebrow mb-1">{label}</div><div className="text-[13px]">{value}</div></div>
);

/** Printable invoice view (always light, for paper). */
function Invoice({ r, onClose }: { r: Detail; onClose: () => void }) {
  const paid = r.items.filter((i) => i.status === 'DELIVERED' && !i.free);
  const free = r.items.filter((i) => i.status === 'DELIVERED' && i.free).length;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Invoice ${r.invoiceNumber}`} size="lg" footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" onClick={() => window.print()}><Printer /> Print</Button></>}>
      <div data-theme="light" className="print-area rounded-lg border border-border bg-white p-6 text-[12.5px] text-[#0b0b0b]">
        <div className="flex justify-between"><div><div className="text-[18px] font-semibold tracking-[-0.02em]">Invoice</div><div className="font-mono text-[12px] text-[#5b5b57]">{r.invoiceNumber}</div></div><div className="text-right text-[#5b5b57]"><div>Issued {fmtDateTime(r.decidedAt ?? r.createdAt)}</div><div>Request {r.code}</div><div><StatusBadge status={r.billingStatus} /></div></div></div>
        <div className="mt-4 text-[#5b5b57]">Billed to <b className="text-[#0b0b0b]">{r.organization?.name ?? 'Your workspace'}</b></div>
        <table className="mt-4 w-full">
          <thead><tr className="border-b border-[#e8e8e4] text-left text-[10.5px] tracking-[0.08em] text-[#898984] uppercase"><th className="py-2">Description</th><th className="py-2 text-right">Qty</th><th className="py-2 text-right">Amount</th></tr></thead>
          <tbody>
            <tr className="border-b border-[#e8e8e4]"><td className="py-2">Marketplace leads delivered</td><td className="tnum py-2 text-right">{paid.length}</td><td className="tnum py-2 text-right">{money(r.subtotal * 100, r.currency)}</td></tr>
            {free > 0 && <tr className="border-b border-[#e8e8e4]"><td className="py-2">Free demo leads</td><td className="tnum py-2 text-right">{free}</td><td className="tnum py-2 text-right">{money(0, r.currency)}</td></tr>}
          </tbody>
        </table>
        <div className="mt-3 ml-auto w-64">
          {r.discount > 0 && <div className="flex justify-between text-[#5b5b57]"><span>Discount</span><span className="tnum">−{money(r.discount * 100, r.currency)}</span></div>}
          {r.tax > 0 && <div className="flex justify-between text-[#5b5b57]"><span>Tax</span><span className="tnum">{money(r.tax * 100, r.currency)}</span></div>}
          <div className="mt-1 flex justify-between border-t border-[#0b0b0b] pt-1.5 text-[14px] font-semibold"><span>Total</span><span className="tnum">{money(r.total * 100, r.currency)}</span></div>
          {r.paymentMethod === 'CREDITS' && <div className="mt-1 flex justify-between text-[#5b5b57]"><span>Paid with credits</span><span className="tnum">{fmtInt(r.creditsCharged ?? 0)}</span></div>}
        </div>
      </div>
    </Dialog>
  );
}

