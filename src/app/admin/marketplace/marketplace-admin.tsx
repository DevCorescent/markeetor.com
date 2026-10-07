'use client';
import { Clock, Gift, Receipt, Store, Wallet } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { RequestsTable } from '@/components/marketplace/requests';
import { fmtInt } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';
import { money } from '@/lib/pricing';
import { CouponsAdmin } from './coupons-admin';
import { CreditsAdmin } from './credits-admin';
import { DisputesAdmin, GrowthAdmin } from './growth-admin';
import { PricingEditor } from './pricing-editor';

type Overview = {
  pool: number;
  status: Record<string, { count: number; leads: number; delivered: number }>;
  billing: Record<string, { count: number; amount: number }>;
  clients: { id: string; name: string; requests: number; delivered: number; free: number; due: number; paid: number; waived: number }[];
};

export function MarketplaceAdmin() {
  const [s, set] = useUrlState({ tab: 'requests' });
  const { data } = useApiQuery<Overview>('/api/v1/marketplace/overview', { refetchInterval: 30_000 });
  const pricing = useApiQuery<{ pricing: { currency: string } }>('/api/v1/marketplace/pricing');
  const cur = pricing.data?.pricing.currency ?? 'USD';
  const pending = data?.status.PENDING;
  const credits = useApiQuery<{ totals: { pendingRequests: number; awaitingPayment: number } }>('/api/v1/credits/overview', { refetchInterval: 30_000 });
  const creditQueue = (credits.data?.totals.pendingRequests ?? 0) + (credits.data?.totals.awaitingPayment ?? 0);
  const disputes = useApiQuery<{ open: number }>('/api/v1/disputes?page=1&pageSize=1&status=OPEN', { refetchInterval: 30_000 });
  return (
    <>
      <PageHeader title="Lead marketplace" description="Clients browse your available leads with all details hidden, request them individually or in bulk, and are billed by your pricing rules. Every workspace starts with free demo leads." />
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={Store} label="Available to clients" value={fmtInt(data?.pool ?? 0)} sub="valid, unallocated leads" />
        <Tile icon={Clock} label="Awaiting your review" value={fmtInt(pending?.count ?? 0)} sub={`${fmtInt(pending?.leads ?? 0)} leads reserved`} strong={(pending?.count ?? 0) > 0} />
        <Tile icon={Wallet} label="Outstanding" value={money((data?.billing.DUE?.amount ?? 0) * 100, cur)} sub={`${fmtInt(data?.billing.DUE?.count ?? 0)} unpaid invoices`} />
        <Tile icon={Receipt} label="Collected" value={money((data?.billing.PAID?.amount ?? 0) * 100, cur)} sub={`${fmtInt((data?.status.FULFILLED?.delivered ?? 0) + (data?.status.PARTIAL?.delivered ?? 0))} leads delivered via requests`} />
      </div>
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}>
        <TabsList className="mb-4 overflow-x-auto">
          <TabsTrigger value="requests">Requests{pending?.count ? ` (${pending.count})` : ''}</TabsTrigger>
          <TabsTrigger value="pricing">Pricing & rules</TabsTrigger>
          <TabsTrigger value="credits">Credits{creditQueue ? ` (${creditQueue})` : ''}</TabsTrigger>
          <TabsTrigger value="disputes">Quality reports{disputes.data?.open ? ` (${disputes.data.open})` : ''}</TabsTrigger>
          <TabsTrigger value="coupons">Coupons</TabsTrigger>
          <TabsTrigger value="growth">Growth</TabsTrigger>
          <TabsTrigger value="clients">Clients & billing</TabsTrigger>
        </TabsList>
      </Tabs>
      {s.tab === 'requests' && <RequestsTable admin />}
      {s.tab === 'pricing' && <PricingEditor />}
      {s.tab === 'credits' && <CreditsAdmin currency={cur} />}
      {s.tab === 'coupons' && <CouponsAdmin />}
      {s.tab === 'disputes' && <DisputesAdmin currency={cur} />}
      {s.tab === 'growth' && <GrowthAdmin />}
      {s.tab === 'clients' && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">{['Client', 'Requests', 'Leads delivered', 'Free demo used', 'Outstanding', 'Paid', 'Waived'].map((h) => <th key={h} className="h-9 px-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {(data?.clients ?? []).map((c) => (
                  <tr key={c.id} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-2.5 font-medium">{c.name}</td>
                    <td className="tnum px-4">{fmtInt(c.requests)}</td>
                    <td className="tnum px-4">{fmtInt(c.delivered)}</td>
                    <td className="tnum px-4"><span className="inline-flex items-center gap-1"><Gift className="size-3 text-subtle" />{fmtInt(c.free)}</span></td>
                    <td className={`tnum px-4 ${c.due > 0 ? 'font-medium text-warn' : 'text-subtle'}`}>{money(c.due * 100, cur)}</td>
                    <td className="tnum px-4">{money(c.paid * 100, cur)}</td>
                    <td className="tnum px-4 text-subtle">{money(c.waived * 100, cur)}</td>
                  </tr>
                ))}
                {!data?.clients.length && <tr><td colSpan={7} className="py-10 text-center text-subtle">No client has requested leads yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function Tile({ icon: Icon, label, value, sub, strong }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub: string; strong?: boolean }) {
  return (
    <Card className={`px-4 py-3.5 ${strong ? 'border-fg ring-1 ring-fg' : ''}`}>
      <div className="eyebrow flex items-center gap-1.5"><Icon className="size-3.5" />{label}</div>
      <div className="tnum mt-2 text-[24px] leading-none font-[520] tracking-[-0.03em]">{value}</div>
      <div className="mt-1.5 text-[11.5px] text-subtle">{sub}</div>
    </Card>
  );
}
