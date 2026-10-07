'use client';
import { ArrowRight, Coins, Gift, Info, Receipt, Tag } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ClientCredits, type CreditSummary } from '@/components/credits/credits-ui';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { fmtCredits } from '@/lib/credits';
import { PageHeader } from '@/components/ui/page';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { fmtInt } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';
import { money } from '@/lib/pricing';
import { CouponOffers } from './coupon-offers';
import { ClientTaxInvoices } from '@/components/finance/client-invoices';
import { RequestsTable } from './requests';

type Summary = {
  currency: string;
  allowance: { total: number; used: number; remaining: number; discountPct: number };
  outstanding: number; paid: number; waived: number; leadsReceived: number; pendingRequests: number;
  priceList: { basePrice: number; minPrice: number; taxPct: number; maxPerRequest: number; clientDiscountPct: number; rules: { name: string; description: string }[]; volumeTiers: { minQty: number; discountPct: number }[]; autoApprove: { free: boolean; paid: boolean } } | null;
};

export function Billing({ canBuy = false }: { canBuy?: boolean }) {
  const { data: s } = useApiQuery<Summary>('/api/v1/marketplace/billing');
  const credits = useApiQuery<CreditSummary>('/api/v1/credits');
  const [u, setU] = useUrlState({ tab: 'overview' });
  const cur = s?.currency ?? 'USD';
  const creditsOn = credits.data?.enabled;
  return (
    <>
      <PageHeader title="Billing" description="Your credits, free demo allowance, lead purchases and invoices from the lead marketplace." actions={<Link href="/app/marketplace" className="text-[12.5px] text-muted hover:text-fg">Browse marketplace <ArrowRight className="inline size-3.5" /></Link>} />
      {creditsOn && (
        <Tabs value={u.tab} onValueChange={(v) => setU({ tab: v })}>
          <TabsList className="mb-4">
            <TabsTrigger value="overview">Invoices & allowance</TabsTrigger>
            <TabsTrigger value="credits"><span className="inline-flex items-center gap-1.5"><Coins className="size-3.5" />{credits.data!.label} · {fmtCredits(credits.data!.balance)}</span></TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {creditsOn && u.tab === 'credits' ? <ClientCredits canBuy={canBuy} /> : !s ? <Skeleton className="h-40" /> : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border border-fg bg-fg px-4 py-3.5 text-inverse">
              <div className="flex items-center gap-1.5 text-[10.5px] font-medium tracking-[0.12em] uppercase opacity-70"><Gift className="size-3.5" />Free demo leads</div>
              <div className="mt-2 flex items-baseline gap-1.5"><span className="tnum text-[26px] leading-none font-semibold tracking-[-0.03em]">{fmtInt(s.allowance.remaining)}</span><span className="text-[12px] opacity-70">of {fmtInt(s.allowance.total)} left · {fmtInt(s.allowance.used)} used</span></div>
              <div className="mt-2.5 h-1 rounded-full bg-inverse/20"><div className="h-full rounded-full bg-inverse" style={{ width: `${s.allowance.total ? (s.allowance.used / s.allowance.total) * 100 : 0}%` }} /></div>
            </div>
            <Tile label="Outstanding" value={money(s.outstanding * 100, cur)} sub={s.outstanding > 0 ? 'Invoiced, awaiting payment' : 'Nothing due'} />
            <Tile label="Paid" value={money(s.paid * 100, cur)} sub={s.waived > 0 ? `${money(s.waived * 100, cur)} waived` : 'All time'} />
            <Tile label="Leads received" value={fmtInt(s.leadsReceived)} sub={`${fmtInt(s.pendingRequests)} request${s.pendingRequests === 1 ? '' : 's'} pending`} />
          </div>

          <CouponOffers compact currency={cur} />
          <ClientTaxInvoices canEditTax={canBuy} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Card>
              <CardHeader title="Invoices" description="Charges are only raised for leads actually delivered to your workspace." />
              <div className="p-3"><RequestsTable billingOnly /></div>
            </Card>
            {s.priceList ? (
              <Card className="self-start">
                <CardHeader title="Price list" description="How lead prices are calculated" />
                <CardBody className="flex flex-col gap-3 text-[12.5px]">
                  <div className="flex items-baseline justify-between"><span className="text-muted">Standard lead</span><span className="tnum text-[16px] font-semibold">{money(s.priceList.basePrice * 100, cur)}</span></div>
                  {s.priceList.rules.length > 0 && (
                    <div>
                      <div className="eyebrow mb-1.5">Adjustments</div>
                      <ul className="flex flex-col gap-1.5">{s.priceList.rules.map((r) => <li key={r.name} className="flex gap-2"><Tag className="mt-0.5 size-3.5 shrink-0 text-subtle" /><span><span className="font-medium">{r.name}</span><span className="block text-[11.5px] text-subtle">{r.description}</span></span></li>)}</ul>
                    </div>
                  )}
                  {s.priceList.volumeTiers.length > 0 && (
                    <div>
                      <div className="eyebrow mb-1.5">Volume discounts</div>
                      <div className="flex flex-wrap gap-1.5">{[...s.priceList.volumeTiers].sort((a, b) => a.minQty - b.minQty).map((t) => <Badge key={t.minQty} tone="outline">{fmtInt(t.minQty)}+ paid leads · {t.discountPct}% off</Badge>)}</div>
                    </div>
                  )}
                  {s.priceList.clientDiscountPct > 0 && <InlineNotice>Your account has an extra <b>{s.priceList.clientDiscountPct}%</b> discount.</InlineNotice>}
                  <div className="flex flex-col gap-1 border-t border-border pt-3 text-[11.5px] text-muted">
                    {s.priceList.taxPct > 0 && <span>Tax: {s.priceList.taxPct}% on the discounted subtotal</span>}
                    <span>Up to {fmtInt(s.priceList.maxPerRequest)} leads per request</span>
                    <span>{s.priceList.autoApprove.free ? 'Free demo leads are delivered instantly.' : 'Free demo leads are delivered after review.'} {s.priceList.autoApprove.paid ? 'Paid requests are delivered instantly.' : 'Paid requests are reviewed by the platform team.'}</span>
                  </div>
                </CardBody>
              </Card>
            ) : (
              <InlineNotice><Info className="mr-1 inline size-3.5" />Prices are shown when you request leads.</InlineNotice>
            )}
          </div>
          <p className="flex items-center gap-1.5 text-[11.5px] text-subtle"><Receipt className="size-3.5" />Payments are settled with the platform team; this page shows charges recorded against your workspace.</p>
        </div>
      )}
    </>
  );
}

const Tile = ({ label, value, sub }: { label: string; value: string; sub: string }) => (
  <Card className="px-4 py-3.5"><div className="eyebrow">{label}</div><div className="tnum mt-2 text-[24px] leading-none font-[520] tracking-[-0.03em]">{value}</div><div className="mt-1.5 text-[11.5px] text-subtle">{sub}</div></Card>
);
