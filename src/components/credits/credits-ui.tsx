'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Ban, Check, Clock, Coins, Copy, CreditCard, Hourglass, Plus, Printer, Send, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/data/data-table';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, Drawer } from '@/components/ui/overlay';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { CREDIT_ENTRY_LABEL, CREDIT_REQUEST_LABEL, fmtCredits, type CreditPackage } from '@/lib/credits';
import { fmtAgo, fmtDate, fmtDateTime } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { PayOnlineButton } from '@/components/finance/pay-online';
import { MyReports, ReferralCard } from '@/components/growth/client-growth';
import { money } from '@/lib/pricing';

export type CreditReq = {
  id: string; code: string; status: string; organizationId: string; packageName: string | null; credits: number; bonusCredits: number;
  currency: string; amount: number; tax: number; total: number; clientNote: string | null; adminNote: string | null; paymentDetails: string | null;
  clientReference: string | null; paymentMethod: string | null; paymentReference: string | null; invoiceNumber: string | null;
  paidAt: string | null; decidedAt: string | null; createdAt: string;
  organization?: { name: string } | null; requester?: { name: string; email: string } | null; decidedBy?: { name: string } | null;
};
type Entry = {
  id: string; type: string; credits: number; balanceAfter: number; note: string | null; createdAt: string; expiresAt: string | null; remaining: number | null;
  leadRequest: { code: string } | null; creditRequest: { code: string } | null; actor?: string | null; organization?: { name: string } | null;
};
export type CreditSummary = {
  enabled: boolean; label: string; onlinePayment?: boolean; currency: string; balance: number; lifetimeIn: number; lifetimeSpent: number; expiringSoon: number; nextExpiry: string | null; openRequests: number;
  rules: {
    costMode: 'price' | 'fixed'; creditValue: number; fixedCreditsPerLead: number; spendDiscountPct: number; packages: CreditPackage[];
    custom: { enabled: boolean; minCredits: number; maxCredits: number; pricePerCredit: number }; bonusTiers: { minCredits: number; bonusPct: number }[]; clientBonusPct: number;
    taxPct: number; expiryDays: number | null; autoDeliver: boolean; allowInvoice: boolean; paymentInstructions: string;
  };
};

const invalidateCredits = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ predicate: (q) => /^\/api\/v1\/(credits|marketplace)/.test(String(q.queryKey[0] ?? '')) });

// ── Credit requests (purchases) ────────────────────────────────────

const STATUSES = ['PENDING', 'AWAITING_PAYMENT', 'COMPLETED', 'REJECTED', 'CANCELLED'];

export function CreditRequestsTable({ admin = false, organizationId, defaultStatus }: { admin?: boolean; organizationId?: string; defaultStatus?: string }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(defaultStatus ?? '');
  const [open, setOpen] = useState<string | null>(null);
  const url = `/api/v1/credits/requests?page=${page}&pageSize=25${status ? `&status=${status}` : ''}${organizationId ? `&organizationId=${organizationId}` : ''}`;
  const { data, isFetching } = useApiQuery<{ total: number; rows: CreditReq[] }>(url, { refetchInterval: 20_000 });
  const cols: ColumnDef<CreditReq, unknown>[] = [
    { id: 'code', header: 'Request', cell: ({ row: { original: r } }) => <div><div className="font-mono text-[12px] text-fg">{r.code}</div><div className="text-[11px] text-subtle">{fmtDateTime(r.createdAt)}</div></div> },
    ...(admin ? [{ id: 'org', header: 'Client', cell: ({ row: { original: r } }: { row: { original: CreditReq } }) => <div><div>{r.organization?.name ?? '—'}</div><div className="text-[11px] text-subtle">{r.requester?.name}</div></div> }] : []),
    { id: 'credits', header: 'Credits', cell: ({ row: { original: r } }) => <div className="tnum"><span className="font-medium">{fmtCredits(r.credits)}</span>{r.bonusCredits > 0 && <span className="text-subtle"> +{fmtCredits(r.bonusCredits)} bonus</span>}{r.packageName && <div className="text-[11px] text-subtle">{r.packageName}</div>}</div> },
    { id: 'total', header: 'Amount', cell: ({ row: { original: r } }) => <span className="tnum font-medium">{money(r.total * 100, r.currency)}</span> },
    { id: 'status', header: 'Status', cell: ({ row: { original: r } }) => <div className="flex flex-col items-start gap-0.5"><StatusBadge status={r.status} />{r.clientReference && ['PENDING', 'AWAITING_PAYMENT'].includes(r.status) && <span className="text-[10.5px] text-subtle">Paid · ref {r.clientReference}</span>}</div> },
    { id: 'payment', header: 'Payment', cell: ({ row: { original: r } }) => <span className="text-muted">{r.paymentMethod ? `${r.paymentMethod}${r.paymentReference ? ` · ${r.paymentReference}` : ''}` : '—'}</span> },
    { id: 'updated', header: 'Updated', cell: ({ row: { original: r } }) => <span className="text-subtle">{fmtAgo(r.paidAt ?? r.decidedAt ?? r.createdAt)}</span> },
  ];
  return (
    <>
      <DataTable
        columns={cols} data={data?.rows ?? []} total={data?.total ?? 0} page={page} pageSize={25} onPage={setPage} loading={isFetching} getRowId={(r) => r.id} onRowClick={(r) => setOpen(r.id)}
        empty={<div className="py-10 text-center text-[12.5px] text-subtle">No credit requests{status ? ' with this status' : ' yet'}.</div>}
        toolbar={
          <Select className="h-7 w-44 text-[12px]" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status">
            <option value="">All statuses</option><option value="OPEN">Open (needs action)</option>{STATUSES.map((s) => <option key={s} value={s}>{CREDIT_REQUEST_LABEL[s]}</option>)}
          </Select>
        }
      />
      {open && <CreditRequestDrawer id={open} admin={admin} onClose={() => setOpen(null)} />}
    </>
  );
}

function Timeline({ r }: { r: CreditReq }) {
  const steps = [
    { label: 'Requested', at: r.createdAt, done: true, icon: Plus },
    { label: 'Payment details sent', at: r.status === 'AWAITING_PAYMENT' || r.status === 'COMPLETED' ? (r.status === 'COMPLETED' ? null : r.createdAt) : null, done: r.status === 'AWAITING_PAYMENT' || r.status === 'COMPLETED', icon: Send },
    { label: r.clientReference ? `Client reported payment · ${r.clientReference}` : 'Client pays', at: null, done: Boolean(r.clientReference) || r.status === 'COMPLETED', icon: CreditCard },
    { label: r.status === 'REJECTED' ? 'Declined' : r.status === 'CANCELLED' ? 'Cancelled' : 'Payment confirmed · credits added', at: r.decidedAt, done: ['COMPLETED', 'REJECTED', 'CANCELLED'].includes(r.status), icon: r.status === 'COMPLETED' ? Check : r.status === 'PENDING' || r.status === 'AWAITING_PAYMENT' ? Hourglass : X },
  ];
  return (
    <ol className="flex flex-col gap-0">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span className={cn('grid size-6 place-items-center rounded-full border', s.done ? 'border-fg bg-fg text-inverse' : 'border-border-strong text-subtle')}><s.icon className="size-3" /></span>
            {i < steps.length - 1 && <span className={cn('w-px flex-1', s.done ? 'bg-fg/40' : 'bg-border')} style={{ minHeight: 14 }} />}
          </div>
          <div className="pb-3 text-[12.5px]"><div className={s.done ? 'text-fg' : 'text-subtle'}>{s.label}</div>{s.at && <div className="text-[11px] text-subtle">{fmtDateTime(s.at)}</div>}</div>
        </li>
      ))}
    </ol>
  );
}

function CreditRequestDrawer({ id, admin, onClose }: { id: string; admin: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: r } = useApiQuery<CreditReq>(`/api/v1/credits/requests/${id}`);
  const wallet = useApiQuery<CreditSummary>(admin ? null : '/api/v1/credits');
  const online = Boolean(wallet.data?.onlinePayment);
  const settings = useApiQuery<{ settings: { paymentMethods: string[]; paymentInstructions: string; label: string } }>(admin ? '/api/v1/credits/settings' : null);
  const [dialog, setDialog] = useState<null | 'details' | 'complete' | 'reject' | 'reference' | 'receipt'>(null);
  const [text, setText] = useState('');
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [received, setReceived] = useState('');
  const [extra, setExtra] = useState('0');
  const [busy, setBusy] = useState(false);
  if (!r) return null;
  const open = ['PENDING', 'AWAITING_PAYMENT'].includes(r.status);
  const act = async (path: string, body: unknown, msg: string) => {
    setBusy(true);
    try {
      await api(`/api/v1/credits/requests/${id}/${path}`, { method: 'POST', body });
      toast.success(msg);
      await invalidateCredits(qc);
      setDialog(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const openDialog = (d: NonNullable<typeof dialog>) => {
    setText(d === 'details' ? (r.paymentDetails || settings.data?.settings.paymentInstructions || '') : '');
    setMethod(settings.data?.settings.paymentMethods[0] ?? 'Bank transfer');
    setReference(r.clientReference ?? '');
    setReceived(String(r.total));
    setExtra('0');
    setDialog(d);
  };
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="md" title={`Credit request ${r.code}`}
      description={`${admin ? `${r.organization?.name ?? ''} · ` : ''}${r.requester?.name ?? ''} · ${fmtDateTime(r.createdAt)}`}
      footer={<>
        {r.invoiceNumber && <Button variant="ghost" onClick={() => setDialog('receipt')}><Printer /> Receipt</Button>}
        {!admin && open && <Button variant="ghost" loading={busy} onClick={() => act('cancel', undefined, 'Request cancelled')}><X /> Cancel</Button>}
        {!admin && open && <Button variant={online ? 'ghost' : 'primary'} onClick={() => openDialog('reference')}><CreditCard /> {r.clientReference ? 'Update payment reference' : 'I’ve paid'}</Button>}
        {!admin && open && online && <PayOnlineButton creditRequestId={r.id} />}
        {admin && open && <>
          <Button variant="ghost" onClick={() => openDialog('reject')}><Ban /> Decline</Button>
          <Button variant="ghost" onClick={() => openDialog('details')}><Send /> {r.status === 'AWAITING_PAYMENT' ? 'Resend' : 'Send'} payment details</Button>
          <Button variant="primary" onClick={() => openDialog('complete')}><Check /> Payment received</Button>
        </>}
      </>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Status" value={<StatusBadge status={r.status} />} />
          <Stat label="Credits" value={<span className="tnum">{fmtCredits(r.credits)}{r.bonusCredits > 0 && <span className="text-subtle"> + {fmtCredits(r.bonusCredits)} bonus</span>}</span>} />
        </div>
        <div className="rounded-lg border border-border px-3.5 py-2.5 text-[12.5px]">
          <div className="flex justify-between text-muted"><span>{r.packageName ? `${r.packageName} pack` : 'Custom amount'}</span><span className="tnum">{money(r.amount * 100, r.currency)}</span></div>
          {r.tax > 0 && <div className="flex justify-between text-muted"><span>Tax</span><span className="tnum">{money(r.tax * 100, r.currency)}</span></div>}
          <div className="mt-1 flex justify-between border-t border-border pt-1.5 font-medium"><span>Total to pay</span><span className="tnum">{money(r.total * 100, r.currency)}</span></div>
        </div>
        {r.paymentDetails && open && (
          <div className="rounded-lg border border-border-strong bg-surface-2 px-3.5 py-3">
            <div className="mb-1.5 flex items-center justify-between"><span className="eyebrow">How to pay</span><button type="button" className="flex items-center gap-1 text-[11px] text-subtle hover:text-fg" onClick={() => { void navigator.clipboard?.writeText(r.paymentDetails!); toast.success('Copied'); }}><Copy className="size-3" />Copy</button></div>
            <p className="text-[12.5px] leading-relaxed whitespace-pre-line">{r.paymentDetails}</p>
            <p className="mt-2 text-[11.5px] text-subtle">Mention <b className="font-mono text-fg">{r.code}</b> with your payment.</p>
          </div>
        )}
        {r.clientNote && <InlineNotice><b className="font-medium">Client note:</b> {r.clientNote}</InlineNotice>}
        {r.adminNote && <InlineNotice tone={r.status === 'REJECTED' ? 'warn' : 'neutral'}><b className="font-medium">Platform note:</b> {r.adminNote}</InlineNotice>}
        {r.status === 'COMPLETED' && (
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Paid via" value={r.paymentMethod ?? '—'} />
            <Stat label="Reference" value={<span className="font-mono text-[12px]">{r.paymentReference ?? '—'}</span>} />
            <Stat label="Receipt" value={<span className="font-mono text-[12px]">{r.invoiceNumber}</span>} />
            <Stat label="Confirmed" value={`${r.paidAt ? fmtDateTime(r.paidAt) : '—'}${admin && r.decidedBy ? ` · ${r.decidedBy.name}` : ''}`} />
          </div>
        )}
        <div><div className="eyebrow mb-2">Progress</div><Timeline r={r} /></div>
      </div>

      <Dialog open={dialog === 'details'} onOpenChange={(o) => !o && setDialog(null)} title="Send payment details" description="The client is notified and sees these details on their Billing page."
        footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={text.trim().length < 3} onClick={() => act('payment-details', { details: text }, 'Payment details sent')}><Send /> Send</Button></>}>
        <Field label="Payment details"><Textarea rows={5} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder="Bank account, UPI id, payment link…" /></Field>
      </Dialog>
      <Dialog open={dialog === 'complete'} onOpenChange={(o) => !o && setDialog(null)} title="Confirm payment & add credits" description={`Adds ${fmtCredits(r.credits + r.bonusCredits)} credits to ${r.organization?.name ?? 'the workspace'} and issues a receipt.`}
        footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!method} onClick={() => act('complete', { paymentMethod: method, paymentReference: reference || undefined, amountReceived: Number(received) || undefined, extraCredits: Number(extra) || undefined, note: text || undefined }, 'Credits added')}><Check /> Add {fmtCredits(r.credits + r.bonusCredits + (Number(extra) || 0))} credits</Button></>}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Payment method"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{(settings.data?.settings.paymentMethods ?? ['Bank transfer']).map((m) => <option key={m}>{m}</option>)}</Select></Field>
          <Field label="Payment reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / transaction id" maxLength={120} /></Field>
          <Field label={`Amount received (${r.currency})`}><Input type="number" min={0} step={0.01} value={received} onChange={(e) => setReceived(e.target.value)} /></Field>
          <Field label="Extra goodwill credits"><Input type="number" min={0} value={extra} onChange={(e) => setExtra(e.target.value)} /></Field>
        </div>
        {Number(received) > 0 && Number(received) !== r.total && <InlineNotice tone="warn" className="mt-3">The amount received differs from the request total ({money(r.total * 100, r.currency)}). It is recorded on the request.</InlineNotice>}
        <Field label="Internal note (optional)" className="mt-3"><Textarea rows={2} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} /></Field>
      </Dialog>
      <Dialog open={dialog === 'reject'} onOpenChange={(o) => !o && setDialog(null)} title="Decline credit request" description="The client is notified with your reason. No credits are added."
        footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button variant="danger" loading={busy} disabled={text.trim().length < 3} onClick={() => act('reject', { reason: text }, 'Request declined')}>Decline</Button></>}>
        <Field label="Reason"><Textarea rows={3} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} /></Field>
      </Dialog>
      <Dialog open={dialog === 'reference'} onOpenChange={(o) => !o && setDialog(null)} title="Tell us about your payment" description="The platform team checks the payment and adds your credits."
        footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={reference.trim().length < 3} onClick={() => act('reference', { reference }, 'Thanks — we’ll confirm your payment shortly')}>Submit</Button></>}>
        <Field label="Payment reference" hint="UTR, transaction id or cheque number"><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} autoFocus /></Field>
      </Dialog>
      {dialog === 'receipt' && <Receipt r={r} onClose={() => setDialog(null)} />}
    </Drawer>
  );
}

function Receipt({ r, onClose }: { r: CreditReq; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Receipt ${r.invoiceNumber}`} size="lg" footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" onClick={() => window.print()}><Printer /> Print</Button></>}>
      <div data-theme="light" className="print-area rounded-lg border border-border bg-white p-6 text-[12.5px] text-[#0b0b0b]">
        <div className="flex justify-between"><div><div className="text-[18px] font-semibold tracking-[-0.02em]">Receipt</div><div className="font-mono text-[12px] text-[#5b5b57]">{r.invoiceNumber}</div></div><div className="text-right text-[#5b5b57]"><div>Paid {r.paidAt ? fmtDateTime(r.paidAt) : '—'}</div><div>Request {r.code}</div><div>{r.paymentMethod}{r.paymentReference ? ` · ${r.paymentReference}` : ''}</div></div></div>
        <div className="mt-4 text-[#5b5b57]">Received from <b className="text-[#0b0b0b]">{r.organization?.name ?? 'Your workspace'}</b></div>
        <table className="mt-4 w-full">
          <thead><tr className="border-b border-[#e8e8e4] text-left text-[10.5px] tracking-[0.08em] text-[#898984] uppercase"><th className="py-2">Description</th><th className="py-2 text-right">Credits</th><th className="py-2 text-right">Amount</th></tr></thead>
          <tbody>
            <tr className="border-b border-[#e8e8e4]"><td className="py-2">Lead credits{r.packageName ? ` — ${r.packageName} pack` : ''}</td><td className="tnum py-2 text-right">{fmtCredits(r.credits)}</td><td className="tnum py-2 text-right">{money(r.amount * 100, r.currency)}</td></tr>
            {r.bonusCredits > 0 && <tr className="border-b border-[#e8e8e4]"><td className="py-2">Bonus credits</td><td className="tnum py-2 text-right">{fmtCredits(r.bonusCredits)}</td><td className="tnum py-2 text-right">{money(0, r.currency)}</td></tr>}
          </tbody>
        </table>
        <div className="mt-3 ml-auto w-64">
          {r.tax > 0 && <div className="flex justify-between text-[#5b5b57]"><span>Tax</span><span className="tnum">{money(r.tax * 100, r.currency)}</span></div>}
          <div className="mt-1 flex justify-between border-t border-[#0b0b0b] pt-1.5 text-[14px] font-semibold"><span>Total paid</span><span className="tnum">{money(r.total * 100, r.currency)}</span></div>
        </div>
      </div>
    </Dialog>
  );
}

const Stat = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="rounded-lg border border-border px-3 py-2"><div className="eyebrow mb-1">{label}</div><div className="text-[13px]">{value}</div></div>
);

// ── Ledger history ─────────────────────────────────────────────────

const ENTRY_TYPES = ['PURCHASE', 'BONUS', 'WELCOME', 'GRANT', 'SPEND', 'REFUND', 'ADJUSTMENT', 'EXPIRY'];

export function CreditHistoryTable({ admin = false, organizationId, orgs }: { admin?: boolean; organizationId?: string; orgs?: { id: string; name: string }[] }) {
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const [org, setOrg] = useState(organizationId ?? '');
  const url = `/api/v1/credits/entries?page=${page}&pageSize=50${type ? `&type=${type}` : ''}${org ? `&organizationId=${org}` : ''}`;
  const { data, isFetching } = useApiQuery<{ total: number; rows: Entry[] }>(url);
  const cols: ColumnDef<Entry, unknown>[] = [
    { id: 'when', header: 'Date', cell: ({ row: { original: e } }) => <span className="whitespace-nowrap text-muted">{fmtDateTime(e.createdAt)}</span> },
    ...(admin && !organizationId ? [{ id: 'org', header: 'Client', cell: ({ row: { original: e } }: { row: { original: Entry } }) => <span>{e.organization?.name ?? '—'}</span> }] : []),
    {
      id: 'type', header: 'Type',
      cell: ({ row: { original: e } }) => (
        <span className="flex items-center gap-1.5">
          {e.credits > 0 ? <ArrowDownLeft className="size-3.5 text-ok" /> : <ArrowUpRight className="size-3.5 text-muted" />}
          {CREDIT_ENTRY_LABEL[e.type] ?? e.type}
        </span>
      ),
    },
    { id: 'detail', header: 'Details', cell: ({ row: { original: e } }) => <div className="max-w-[320px]"><div className="truncate text-fg-2">{e.note ?? '—'}</div><div className="text-[11px] text-subtle">{[e.leadRequest && `Lead request ${e.leadRequest.code}`, e.creditRequest && `Credit request ${e.creditRequest.code}`, admin && e.actor && `by ${e.actor}`].filter(Boolean).join(' · ')}</div></div> },
    { id: 'credits', header: 'Credits', cell: ({ row: { original: e } }) => <span className={cn('tnum font-medium', e.credits > 0 ? 'text-fg' : 'text-muted')}>{e.credits > 0 ? '+' : '−'}{fmtCredits(Math.abs(e.credits))}</span> },
    { id: 'balance', header: 'Balance', cell: ({ row: { original: e } }) => <span className="tnum text-muted">{fmtCredits(e.balanceAfter)}</span> },
    { id: 'expires', header: 'Expires', cell: ({ row: { original: e } }) => (e.expiresAt ? <span className={cn('text-[11.5px]', new Date(e.expiresAt) < new Date() ? 'text-subtle line-through' : 'text-muted')}>{fmtDate(e.expiresAt)}{e.remaining != null && e.remaining < e.credits && <span className="text-subtle"> · {fmtCredits(e.remaining)} left</span>}</span> : <span className="text-subtle">—</span>) },
  ];
  return (
    <DataTable
      columns={cols} data={data?.rows ?? []} total={data?.total ?? 0} page={page} pageSize={50} onPage={setPage} loading={isFetching} getRowId={(e) => e.id}
      empty={<div className="py-10 text-center text-[12.5px] text-subtle">No credit activity yet.</div>}
      toolbar={
        <div className="flex flex-wrap gap-2">
          <Select className="h-7 w-44 text-[12px]" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} aria-label="Type">
            <option value="">All activity</option><option value="PURCHASE,BONUS,WELCOME,GRANT">Credits in</option><option value="SPEND,ADJUSTMENT,EXPIRY">Credits out</option>
            {ENTRY_TYPES.map((t) => <option key={t} value={t}>{CREDIT_ENTRY_LABEL[t]}</option>)}
          </Select>
          {admin && !organizationId && orgs && (
            <Select className="h-7 w-52 text-[12px]" value={org} onChange={(e) => { setOrg(e.target.value); setPage(1); }} aria-label="Client"><option value="">All clients</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
          )}
        </div>
      }
    />
  );
}

// ── Client: wallet + buying ────────────────────────────────────────

export function ClientCredits({ canBuy }: { canBuy: boolean }) {
  const { data: s } = useApiQuery<CreditSummary>('/api/v1/credits');
  const [buy, setBuy] = useState(false);
  if (!s) return <Skeleton className="h-48" />;
  if (!s.enabled) return <InlineNotice>{s.label ?? 'Credits'} are not available right now.</InlineNotice>;
  const r = s.rules;
  const spendRule = r.costMode === 'fixed' ? `${fmtCredits(r.fixedCreditsPerLead)} ${s.label.toLowerCase()} per paid lead` : `1 ${s.label.toLowerCase().replace(/s$/, '')} = ${money(Math.round(r.creditValue * 100), s.currency)} of lead value`;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col justify-between gap-4 rounded-lg border border-fg bg-fg px-5 py-4 text-inverse">
          <div className="flex items-center justify-between"><span className="flex items-center gap-1.5 text-[10.5px] font-medium tracking-[0.12em] uppercase opacity-70"><Coins className="size-3.5" />{s.label} balance</span>{s.openRequests > 0 && <span className="text-[11px] opacity-70">{s.openRequests} purchase{s.openRequests === 1 ? '' : 's'} in progress</span>}</div>
          <div className="tnum text-[40px] leading-none font-semibold tracking-[-0.04em]">{fmtCredits(s.balance)}</div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] opacity-70">≈ {money(Math.round(s.balance * r.creditValue * 100), s.currency)} of leads{r.costMode === 'fixed' ? ` · ${fmtCredits(Math.floor(s.balance / r.fixedCreditsPerLead))} leads` : ''}</span>
            {canBuy && <button type="button" onClick={() => setBuy(true)} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-inverse px-3 text-[12.5px] font-medium text-fg hover:opacity-90"><Plus className="size-3.5" />Buy {s.label.toLowerCase()}</button>}
          </div>
        </div>
        <Card className="px-4 py-3.5">
          <div className="eyebrow">Lifetime</div>
          <div className="mt-2 flex items-baseline gap-4"><div><div className="tnum text-[20px] font-[520] tracking-[-0.03em]">{fmtCredits(s.lifetimeIn)}</div><div className="text-[11.5px] text-subtle">received</div></div><div><div className="tnum text-[20px] font-[520] tracking-[-0.03em]">{fmtCredits(s.lifetimeSpent)}</div><div className="text-[11.5px] text-subtle">spent on leads</div></div></div>
        </Card>
        <Card className="px-4 py-3.5">
          <div className="eyebrow">Expiring in 30 days</div>
          <div className="tnum mt-2 text-[20px] font-[520] tracking-[-0.03em]">{fmtCredits(s.expiringSoon)}</div>
          <div className="mt-1 text-[11.5px] text-subtle">{s.expiringSoon > 0 && s.nextExpiry ? <span className="flex items-center gap-1"><Clock className="size-3" />Next on {fmtDate(s.nextExpiry)}</span> : r.expiryDays ? `Credits last ${r.expiryDays} days` : 'Credits never expire'}</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-4">
          <Card><CardHeader title="Credit purchases" description="Request credits, pay the platform team, and they’re added as soon as payment is confirmed." /><div className="p-3"><CreditRequestsTable /></div></Card>
          <Card><CardHeader title="Credit history" description="Every credit in and out of your workspace." /><div className="p-3"><CreditHistoryTable /></div></Card>
          <MyReports />
        </div>
        <div className="flex flex-col gap-4 self-start">
        <ReferralCard />
        <Card>
          <CardHeader title="How credits work" />
          <CardBody className="flex flex-col gap-2.5 text-[12.5px] text-fg-2">
            <Rule icon={Coins}>{spendRule}{r.spendDiscountPct > 0 && <> — <b className="font-medium">{r.spendDiscountPct}% off</b> when you pay with credits</>}.</Rule>
            <Rule icon={Sparkles}>{r.autoDeliver ? 'Requests paid with credits are delivered instantly.' : 'Requests paid with credits are reviewed, then delivered.'}</Rule>
            <Rule icon={ArrowDownLeft}>You’re only charged for leads actually delivered — anything else is refunded to your balance.</Rule>
            {r.bonusTiers.length > 0 && r.custom.enabled && <Rule icon={Plus}>Bonus on custom amounts: {[...r.bonusTiers].sort((a, b) => a.minCredits - b.minCredits).map((t) => `${fmtCredits(t.minCredits)}+ → +${t.bonusPct}%`).join(', ')}.</Rule>}
            {r.clientBonusPct > 0 && <Rule icon={Sparkles}>Your account gets <b className="font-medium">+{r.clientBonusPct}%</b> bonus credits on every purchase.</Rule>}
            <Rule icon={Clock}>{r.expiryDays ? `Purchased credits expire ${r.expiryDays} days after they’re added; the soonest-expiring are used first.` : 'Credits never expire.'}</Rule>
            {r.taxPct > 0 && <Rule icon={CreditCard}>Tax of {r.taxPct}% applies when you buy credits; spending them is tax-free.</Rule>}
            {!r.allowInvoice && <InlineNotice>Paid leads are bought with credits.</InlineNotice>}
          </CardBody>
        </Card>
        </div>
      </div>
      {buy && <BuyCreditsDialog s={s} onClose={() => setBuy(false)} />}
    </div>
  );
}

const Rule = ({ icon: I, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) => (
  <p className="flex gap-2"><I className="mt-0.5 size-3.5 shrink-0 text-subtle" /><span>{children}</span></p>
);

export function BuyCreditsDialog({ s, onClose, suggested }: { s: CreditSummary; onClose: () => void; suggested?: number }) {
  const qc = useQueryClient();
  const r = s.rules;
  const popular = r.packages.find((p) => p.popular) ?? r.packages[0];
  const [pick, setPick] = useState<string>(suggested && r.custom.enabled ? 'custom' : popular?.id ?? 'custom');
  const [amount, setAmount] = useState(String(Math.max(r.custom.minCredits, suggested ?? r.custom.minCredits)));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<CreditReq | null>(null);
  const pkg = r.packages.find((p) => p.id === pick);
  const n = Math.floor(Number(amount) || 0);
  const tier = [...r.bonusTiers].sort((a, b) => b.minCredits - a.minCredits).find((t) => n >= t.minCredits);
  const credits = pkg ? pkg.credits : n;
  const bonus = pkg ? pkg.bonusCredits + Math.floor((pkg.credits * r.clientBonusPct) / 100) : Math.floor((n * ((tier?.bonusPct ?? 0) + r.clientBonusPct)) / 100);
  const amountCents = pkg ? Math.round(pkg.price * 100) : Math.round(n * r.custom.pricePerCredit * 100);
  const taxCents = Math.round((amountCents * r.taxPct) / 100);
  const invalid = !pkg && (n < r.custom.minCredits || n > r.custom.maxCredits);
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api<CreditReq>('/api/v1/credits/requests', { body: pkg ? { packageId: pkg.id, note: note || undefined } : { credits: n, note: note || undefined } });
      setDone(res);
      await invalidateCredits(qc);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (done) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()} title="Request sent" description={s.onlinePayment ? `Pay now and your credits are added instantly — or pay offline and ${done.code} waits for the platform team.` : `We’ve told the platform team. ${done.code} is in your credit purchases.`} footer={<>{s.onlinePayment && <PayOnlineButton creditRequestId={done.id} onPaid={onClose} />}<Button variant={s.onlinePayment ? 'ghost' : 'primary'} onClick={onClose}>{s.onlinePayment ? 'Pay later' : 'Done'}</Button></>}>
        <div className="flex flex-col gap-3 text-[12.5px]">
          <div className="flex items-center justify-between rounded-lg border border-border px-3.5 py-3"><span>{fmtCredits(done.credits + done.bonusCredits)} {s.label.toLowerCase()}</span><b className="tnum">{money(done.total * 100, done.currency)}</b></div>
          {done.paymentDetails ? (
            <div className="rounded-lg border border-border-strong bg-surface-2 px-3.5 py-3"><div className="eyebrow mb-1.5">How to pay</div><p className="leading-relaxed whitespace-pre-line">{done.paymentDetails}</p><p className="mt-2 text-[11.5px] text-subtle">Mention <b className="font-mono text-fg">{done.code}</b> with your payment, then click “I’ve paid” on the request.</p></div>
          ) : <p className="text-muted">The platform team will send you payment details shortly.</p>}
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={`Buy ${s.label.toLowerCase()}`} description="Choose a pack or an amount. Credits are added as soon as the platform team confirms your payment."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={invalid || credits <= 0} onClick={submit}>Request {fmtCredits(credits + bonus)} {s.label.toLowerCase()} · {money(amountCents + taxCents, s.currency)}</Button></>}>
      <div className="flex flex-col gap-4">
        {suggested ? <InlineNotice>You need <b className="font-medium">{fmtCredits(suggested)}</b> more {s.label.toLowerCase()} for this request.</InlineNotice> : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {r.packages.map((p) => (
            <button key={p.id} type="button" onClick={() => setPick(p.id)} className={cn('relative flex flex-col items-start gap-1 rounded-lg border px-3.5 py-3 text-left transition-colors', pick === p.id ? 'border-fg bg-surface-2' : 'border-border hover:border-border-strong')}>
              {p.popular && <Badge tone="solid" className="absolute top-2 right-2">Popular</Badge>}
              <span className="text-[12px] text-muted">{p.name}</span>
              <span className="tnum text-[20px] font-semibold tracking-[-0.03em]">{fmtCredits(p.credits)}</span>
              <span className="text-[11.5px] text-subtle">{p.bonusCredits > 0 ? `+${fmtCredits(p.bonusCredits)} bonus` : p.description || ' '}</span>
              <span className="tnum mt-1 text-[13px] font-medium">{money(Math.round(p.price * 100), s.currency)}</span>
            </button>
          ))}
          {r.custom.enabled && (
            <button type="button" onClick={() => setPick('custom')} className={cn('flex flex-col items-start gap-1 rounded-lg border px-3.5 py-3 text-left transition-colors', pick === 'custom' ? 'border-fg bg-surface-2' : 'border-border hover:border-border-strong', r.packages.length % 3 === 0 && 'sm:col-span-3')}>
              <span className="text-[12px] text-muted">Custom amount</span>
              <span className="text-[11.5px] text-subtle">{fmtCredits(r.custom.minCredits)}–{fmtCredits(r.custom.maxCredits)} credits at {money(Math.round(r.custom.pricePerCredit * 100), s.currency)} each</span>
            </button>
          )}
        </div>
        {pick === 'custom' && (
          <Field label="Credits" hint={tier ? `+${tier.bonusPct}% bonus at this amount` : r.bonusTiers.length ? `Bonus from ${fmtCredits(Math.min(...r.bonusTiers.map((t) => t.minCredits)))} credits` : undefined}>
            <Input type="number" min={r.custom.minCredits} max={r.custom.maxCredits} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </Field>
        )}
        <div className="rounded-lg border border-border px-3.5 py-2.5 text-[12.5px]">
          <div className="flex justify-between text-muted"><span>{fmtCredits(credits)} {s.label.toLowerCase()}</span><span className="tnum">{money(amountCents, s.currency)}</span></div>
          {bonus > 0 && <div className="flex justify-between text-muted"><span>Bonus</span><span className="tnum">+{fmtCredits(bonus)} {s.label.toLowerCase()}</span></div>}
          {taxCents > 0 && <div className="flex justify-between text-muted"><span>Tax ({r.taxPct}%)</span><span className="tnum">{money(taxCents, s.currency)}</span></div>}
          <div className="mt-1 flex justify-between border-t border-border pt-1.5 font-medium"><span>You pay · you get {fmtCredits(credits + bonus)}</span><span className="tnum">{money(amountCents + taxCents, s.currency)}</span></div>
        </div>
        <Field label="Note for the platform team (optional)"><Textarea rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="PO number, billing contact…" /></Field>
      </div>
    </Dialog>
  );
}
