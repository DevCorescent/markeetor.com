'use client';
import { CheckCircle2, Coins, FileText, Gift, Info, Loader2, ShieldCheck, Ticket, X } from 'lucide-react';
import { BuyCreditsDialog, type CreditSummary } from '@/components/credits/credits-ui';
import { fmtCredits } from '@/lib/credits';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Checkbox, Dialog } from '@/components/ui/overlay';
import { InlineNotice } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { fmtInt } from '@/lib/format';
import { couponLabel, money, type QuoteLine } from '@/lib/pricing';
import { useApiQuery } from '@/lib/hooks';
import { cn } from '@/lib/cn';

export type MarketSelection = { mode: 'ids'; ids: string[] } | { mode: 'filter'; filter: { conditions: unknown[] }; excludeIds: string[]; limit?: number };
type QuoteResp = {
  requested: number; available: number; unavailable: number; autoApprove: boolean; maxPerRequest: number;
  allowance: { total: number; used: number; remaining: number; discountPct: number };
  quote: { currency: string; count: number; freeApplied: number; paidCount: number; subtotalCents: number; discountCents: number; discountPct: number; tierPct: number; clientPct: number; taxCents: number; totalCents: number; lines: QuoteLine[]; couponDiscountCents: number; couponFreeLeads: number };
  coupon: { code: string; name: string; label: string; error: string | null } | null;
  credits: { enabled: boolean; label: string; cost: number; balance: number; enough: boolean; allowInvoice: boolean; autoDeliver: boolean } | null;
};
export type Offer = { code: string; name: string; description: string | null; type: string; value: number; maxDiscount: number | null; minLeads: number; minSubtotal: number; endsAt: string | null; firstRequestOnly: boolean };
type Created = { id: string; code: string; status: string; deliveredCount: number };

export function RequestDialog({ selection, onClose, onDone, initialCoupon }: { selection: MarketSelection | null; onClose: () => void; onDone: (r: Created) => void; initialCoupon?: string }) {
  const [quote, setQuote] = useState<QuoteResp | null>(null);
  const offers = useApiQuery<{ coupons: Offer[] }>(selection ? '/api/v1/marketplace/coupons' : null);
  const [code, setCode] = useState(initialCoupon ?? '');
  const [applied, setApplied] = useState(initialCoupon ?? '');
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pay, setPay] = useState<'CREDITS' | 'INVOICE' | null>(null);
  const [buying, setBuying] = useState(false);
  const wallet = useApiQuery<CreditSummary>(buying ? '/api/v1/credits' : null);
  useEffect(() => {
    if (!selection) return;
    setPay(null);
    setQuote(null); setError(null); setAccept(false); setNote(''); setCode(initialCoupon ?? ''); setApplied(initialCoupon ?? '');
  }, [selection, initialCoupon]);
  useEffect(() => {
    if (!selection) return;
    setQuoting(true);
    api<QuoteResp>('/api/v1/marketplace/quote', { body: { selection, couponCode: applied || undefined } })
      .then((q) => { setQuote(q); setAccept(false); })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setQuoting(false));
  }, [selection, applied]);
  const couponOk = quote?.coupon && !quote.coupon.error;
  const q = quote?.quote;
  const paid = (q?.totalCents ?? 0) > 0;
  const cr = quote?.credits;
  // Default: credits when the balance covers it (or invoices are off), otherwise invoice.
  const method: 'CREDITS' | 'INVOICE' = !paid || !cr ? 'INVOICE' : (pay ?? (cr.enough || !cr.allowInvoice ? 'CREDITS' : 'INVOICE'));
  const byCredits = paid && method === 'CREDITS';
  const short = byCredits && cr ? Math.max(0, cr.cost - cr.balance) : 0;
  const instant = quote?.autoApprove || (byCredits && cr?.autoDeliver);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<Created>('/api/v1/marketplace/requests', { body: { selection, note: note || undefined, acceptCharges: accept, couponCode: couponOk ? quote!.coupon!.code : undefined, paymentMethod: method } });
      if (r.status === 'FULFILLED' || r.status === 'PARTIAL') toast.success(`${fmtInt(r.deliveredCount)} lead${r.deliveredCount === 1 ? ' is' : 's are'} now in My leads`, { description: `Request ${r.code}` });
      else toast.success(`Request ${r.code} sent`, { description: 'You will be notified as soon as it is approved.' });
      onDone(r);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!selection} onOpenChange={(o) => !o && onClose()} size="md"
      title={quote ? `Request ${fmtInt(quote.available)} lead${quote.available === 1 ? '' : 's'}` : 'Request leads'}
      description="Contact details unlock in My leads as soon as the request is delivered."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {short > 0 ? (
          <Button variant="primary" onClick={() => setBuying(true)}><Coins /> Buy {cr!.label.toLowerCase()}</Button>
        ) : (
          <Button variant="primary" loading={busy} disabled={!quote || !quote.available || (paid && !accept)} onClick={submit}>
            {!q ? 'Request' : byCredits ? `${instant ? 'Get leads' : 'Request'} · ${fmtCredits(cr!.cost)} ${cr!.label.toLowerCase()}` : paid ? `Request · ${money(q.totalCents, q.currency)}` : quote?.autoApprove ? 'Get free leads now' : 'Send request'}
          </Button>
        )}
      </>}
    >
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : !quote || !q ? (
        <div className="grid h-40 place-items-center"><Loader2 className="size-5 animate-spin text-subtle" /></div>
      ) : (
        <div className="flex flex-col gap-4">
          {quote.unavailable > 0 && <InlineNotice tone="warn">{fmtInt(quote.unavailable)} of the selected leads are no longer available{quote.requested > quote.maxPerRequest ? ` or exceed the ${fmtInt(quote.maxPerRequest)}-lead limit per request` : ''} and were left out.</InlineNotice>}
          {q.freeApplied - q.couponFreeLeads > 0 && (
            <div className="flex items-center gap-3 rounded-lg border border-border-strong bg-surface-2 px-3.5 py-2.5">
              <Gift className="size-4 shrink-0" />
              <div className="text-[12.5px]"><b className="font-medium">{fmtInt(q.freeApplied - q.couponFreeLeads)} free demo lead{q.freeApplied - q.couponFreeLeads === 1 ? '' : 's'}</b> applied<span className="text-subtle"> — {fmtInt(quote.allowance.remaining - (q.freeApplied - q.couponFreeLeads))} of {fmtInt(quote.allowance.total)} left after this request. Applied to the highest-priced leads first.</span></div>
            </div>
          )}
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-[12.5px]">
              <thead><tr className="border-b border-border bg-surface-2 text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase"><th className="px-3 py-2 font-medium">Item</th><th className="px-3 py-2 text-right font-medium">Qty</th><th className="px-3 py-2 text-right font-medium">Unit</th><th className="px-3 py-2 text-right font-medium">Amount</th></tr></thead>
              <tbody>
                {q.lines.map((l, i) => (
                  <tr key={i} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">{l.label}{l.free && <Badge tone="ok" className="ml-1.5">Free demo</Badge>}</td>
                    <td className="tnum px-3 py-2 text-right">{fmtInt(l.qty)}</td>
                    <td className="tnum px-3 py-2 text-right text-muted">{money(l.unitCents, q.currency)}</td>
                    <td className="tnum px-3 py-2 text-right">{l.free ? <span className="text-subtle line-through">{money(l.unitCents * l.qty, q.currency)}</span> : money(l.unitCents * l.qty, q.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex flex-col gap-1 border-t border-border bg-surface-2 px-3 py-2.5 text-[12.5px]">
              <Row label="Subtotal" value={money(q.subtotalCents, q.currency)} />
              {q.discountCents > 0 && <Row label={`Discount (${[q.tierPct && `${q.tierPct}% volume`, q.clientPct && `${q.clientPct}% account`].filter(Boolean).join(' + ')})`} value={`−${money(q.discountCents, q.currency)}`} />}
              {q.couponDiscountCents > 0 && <Row label={`Coupon ${quote.coupon?.code}`} value={`−${money(q.couponDiscountCents, q.currency)}`} />}
              {q.couponFreeLeads > 0 && <Row label={`Coupon ${quote.coupon?.code}: ${q.couponFreeLeads} free lead${q.couponFreeLeads === 1 ? '' : 's'}`} value="included" />}
              {q.taxCents > 0 && <Row label="Tax" value={money(q.taxCents, q.currency)} />}
              <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2"><span className="font-medium">Total</span><span className="tnum text-[18px] font-semibold tracking-[-0.02em]">{money(q.totalCents, q.currency)}</span></div>
            </div>
          </div>
          {paid && cr && (
            <div>
              <div className="eyebrow mb-1.5">Pay with</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button type="button" onClick={() => setPay('CREDITS')} className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left', method === 'CREDITS' ? 'border-fg bg-surface-2' : 'border-border hover:border-border-strong')}>
                  <Coins className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 text-[12.5px]"><b className="font-medium">{cr.label}</b> · <span className="tnum">{fmtCredits(cr.cost)}</span>
                    <span className={cn('block text-[11.5px]', cr.enough ? 'text-subtle' : 'text-warn')}>Balance {fmtCredits(cr.balance)}{cr.enough ? ` → ${fmtCredits(cr.balance - cr.cost)} after` : ` — ${fmtCredits(cr.cost - cr.balance)} short`}</span></span>
                </button>
                <button type="button" disabled={!cr.allowInvoice} onClick={() => setPay('INVOICE')} className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left disabled:opacity-40', method === 'INVOICE' ? 'border-fg bg-surface-2' : 'border-border hover:border-border-strong')}>
                  <FileText className="mt-0.5 size-4 shrink-0" />
                  <span className="text-[12.5px]"><b className="font-medium">Invoice</b> · <span className="tnum">{money(q.totalCents, q.currency)}</span><span className="block text-[11.5px] text-subtle">{cr.allowInvoice ? 'Pay after delivery' : 'Not available — use credits'}</span></span>
                </button>
              </div>
              {short > 0 && <InlineNotice tone="warn" className="mt-2">You need {fmtCredits(short)} more {cr.label.toLowerCase()} for this request.{cr.allowInvoice ? ' Buy credits, or pay by invoice instead.' : ''}</InlineNotice>}
            </div>
          )}
          <div className="flex items-start gap-2 text-[11.5px] text-muted">
            {instant ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" /> : <Info className="mt-0.5 size-3.5 shrink-0" />}
            {instant ? 'Delivered instantly to your workspace.' : `Reviewed by the platform team; leads are reserved for you in the meantime and you are only ${byCredits ? 'charged credits' : 'billed'} for leads actually delivered.`}
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium"><Ticket className="size-3.5" />Coupon</div>
            {(offers.data?.coupons.length ?? 0) > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {offers.data!.coupons.map((o) => (
                  <button key={o.code} type="button" onClick={() => { setCode(o.code); setApplied(o.code); }}
                    className={cn('flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-[11.5px] transition-colors', applied === o.code ? 'border-fg bg-fg text-inverse' : 'border-border-strong text-muted hover:border-fg hover:text-fg')}>
                    <span className="font-mono font-semibold">{o.code}</span><span className="opacity-80">{couponLabel(o, q.currency)}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setApplied(code.trim()); } }} placeholder="Enter a code" className="h-8 font-mono text-[12px]" aria-label="Coupon code" />
              {applied ? <Button size="sm" variant="ghost" onClick={() => { setCode(''); setApplied(''); }}><X /> Remove</Button> : <Button size="sm" disabled={!code.trim()} loading={quoting} onClick={() => setApplied(code.trim())}>Apply</Button>}
            </div>
            {quote.coupon && <div className={cn('mt-1.5 text-[11.5px]', quote.coupon.error ? 'text-danger' : 'text-ok')}>{quote.coupon.error ?? `${quote.coupon.code} applied — ${quote.coupon.label}`}</div>}
          </div>
          <Field label="Note for the platform team (optional)"><Textarea rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Campaign, urgency, anything useful" /></Field>
          {paid && (
            <label className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 text-[12.5px]">
              <Checkbox checked={accept} onCheckedChange={setAccept} aria-label="Accept charges" />
              <span>{byCredits ? <>I agree to use <b className="tnum font-medium">{fmtCredits(cr!.cost)} {cr!.label.toLowerCase()}</b> for this request. Credits for leads that aren’t delivered are refunded.</> : <>I agree that my workspace will be invoiced <b className="tnum font-medium">{money(q.totalCents, q.currency)}</b> for the leads delivered by this request.</>}</span>
            </label>
          )}
          <div className="flex items-center gap-1.5 text-[11px] text-subtle"><ShieldCheck className="size-3" />Leads are exclusive to your workspace once delivered.</div>
        </div>
      )}
      {buying && wallet.data && <BuyCreditsDialog s={wallet.data} suggested={short} onClose={() => setBuying(false)} />}
    </Dialog>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => <div className="flex justify-between text-muted"><span>{label}</span><span className="tnum">{value}</span></div>;
