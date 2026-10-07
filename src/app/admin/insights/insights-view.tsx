'use client';
import { AlertTriangle, Archive, Boxes, Coins, Hourglass, IndianRupee, Package, Receipt, Search, ShoppingBag, TrendingDown, TrendingUp, Users, Wallet } from 'lucide-react';
import Link from 'next/link';
import { TrendChart } from '@/components/data/charts';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/states';
import { cn } from '@/lib/cn';
import { fmtInt } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';
import { money } from '@/lib/pricing';

const TONES = { ok: 'bg-ok-dim text-ok', info: 'bg-info-dim text-info', accent: 'bg-accent-dim text-accent', warn: 'bg-warn-dim text-warn', danger: 'bg-danger-dim text-danger' } as const;
function Tile({ icon: I, tone, label, value, sub }: { icon: React.ComponentType<{ className?: string }>; tone: keyof typeof TONES; label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-2 px-4 py-3.5">
      <div className="flex items-center justify-between"><span className="eyebrow">{label}</span><span className={cn('grid size-7 place-items-center rounded-md', TONES[tone])}><I className="size-3.5" /></span></div>
      <div className="tnum truncate text-[24px] leading-none font-semibold tracking-[-0.03em]">{value}</div>
      {sub && <div className="text-[11.5px] text-subtle">{sub}</div>}
    </Card>
  );
}
const Bar = ({ value, max, tone = 'bg-info' }: { value: number; max: number; tone?: string }) => <div className="h-1.5 w-full rounded-full bg-surface-3"><div className={cn('h-full rounded-full', tone)} style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }} /></div>;

type Rev = { currency: string; totals: { gross: number; billed: number; creditSales: number; collected: number; tax: number; change: number | null; orders: number; aov: number; leadsSold: number; freeLeads: number; avgPricePerLead: number }; credits: { sold: number; spent: number; outstanding: number; liability: number }; receivables: { amount: number; count: number }; series: { day: string; leads: number; credits: number }[]; topClients: { id: string; name: string; leads: number; credits: number; total: number }[] };

function Revenue({ days }: { days: string }) {
  const { data: r } = useApiQuery<Rev>(`/api/v1/insights/revenue?days=${days}`);
  if (!r) return <Skeleton className="h-96" />;
  const c = r.currency;
  const m = (x: number) => money(Math.round(x * 100), c);
  const top = Math.max(1, ...r.topClients.map((t) => t.total));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={IndianRupee} tone="ok" label="Gross sales" value={m(r.totals.gross)} sub={r.totals.change == null ? 'No previous period' : <span className={r.totals.change >= 0 ? 'text-ok' : 'text-danger'}>{r.totals.change >= 0 ? <TrendingUp className="mr-1 inline size-3" /> : <TrendingDown className="mr-1 inline size-3" />}{Math.abs(r.totals.change)}% vs previous period</span>} />
        <Tile icon={Wallet} tone="info" label="Collected" value={m(r.totals.collected)} sub={`${m(r.totals.tax)} tax included`} />
        <Tile icon={ShoppingBag} tone="accent" label="Orders" value={fmtInt(r.totals.orders)} sub={`Avg order ${m(r.totals.aov)}`} />
        <Tile icon={Receipt} tone="warn" label="Receivables" value={m(r.receivables.amount)} sub={`${fmtInt(r.receivables.count)} unpaid invoices`} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Daily sales" description={`Lead invoices ${m(r.totals.billed)} · credit sales ${m(r.totals.creditSales)}`} />
          <CardBody><TrendChart data={r.series} series={[{ key: 'leads', label: 'Lead invoices' }, { key: 'credits', label: 'Credit sales' }]} height={240} area formatter={(v) => money(Math.round(v * 100), c)} /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Credits" description="Prepaid credits are owed to clients until spent" />
          <CardBody className="grid grid-cols-2 gap-2">
            {([['Sold', fmtInt(r.credits.sold), 'text-ok'], ['Spent', fmtInt(r.credits.spent), 'text-info'], ['Held by clients', fmtInt(r.credits.outstanding), 'text-accent'], ['Liability', m(r.credits.liability), 'text-warn']] as const).map(([k, v, t]) => (
              <div key={k} className="rounded-lg border border-border px-3 py-2.5"><div className="text-[11px] text-subtle">{k}</div><div className={cn('tnum mt-1 text-[18px] font-semibold', t)}>{v}</div></div>
            ))}
            <div className="col-span-2 rounded-lg border border-border px-3 py-2.5 text-[12px]"><span className="text-subtle">Leads sold </span><b className="tnum">{fmtInt(r.totals.leadsSold)}</b><span className="text-subtle"> · free </span>{fmtInt(r.totals.freeLeads)}<span className="text-subtle"> · avg price </span><b className="tnum">{m(r.totals.avgPricePerLead)}</b></div>
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader title="Top clients" description="By lead invoices + credit purchases in this period" />
        <ul className="flex flex-col divide-y divide-border">
          {r.topClients.map((t, i) => (
            <li key={t.id}><Link href={`/admin/organizations/${t.id}`} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px] hover:bg-surface-2">
              <span className="tnum w-5 text-subtle">{i + 1}</span><span className="w-48 truncate font-medium">{t.name}</span><div className="flex-1"><Bar value={t.total} max={top} tone="bg-ok" /></div>
              <span className="tnum w-28 text-right font-medium">{m(t.total)}</span><span className="hidden w-48 text-right text-[11px] text-subtle md:block">{m(t.leads)} leads · {m(t.credits)} credits</span>
            </Link></li>
          ))}
          {!r.topClients.length && <li className="px-4 py-8 text-center text-[12.5px] text-subtle">No sales in this period.</li>}
        </ul>
      </Card>
    </div>
  );
}

type Inv = { total: number; fresh: number; resold: number; floorDays: number | null; atFloor: number; aging: { label: string; count: number }[]; industries: { industry: string; available: number; sold30: number; sellThrough: number; daysOfCover: number | null }[]; states: { state: string; available: number }[] };

function Inventory() {
  const { data: v } = useApiQuery<Inv>('/api/v1/insights/inventory');
  if (!v) return <Skeleton className="h-96" />;
  const maxA = Math.max(1, ...v.aging.map((a) => a.count));
  const maxS = Math.max(1, ...v.states.map((s) => s.available));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={Boxes} tone="info" label="Available stock" value={fmtInt(v.total)} sub={`${fmtInt(v.fresh)} never sold · ${fmtInt(v.resold)} resold`} />
        <Tile icon={Package} tone="ok" label="Fresh share" value={`${v.total ? Math.round((v.fresh / v.total) * 100) : 0}%`} sub="Never offered to anyone" />
        <Tile icon={Hourglass} tone="warn" label="Older than 90 days" value={fmtInt(v.aging[3]?.count ?? 0)} sub="Consider repricing or archiving" />
        <Tile icon={Archive} tone="danger" label="At price floor" value={fmtInt(v.atFloor)} sub={v.floorDays != null ? `Age ≥ ${v.floorDays} days — can't get cheaper` : 'Age pricing is off'} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Stock by industry" description="Sell-through = sold in 30 days ÷ (sold + available). Days of cover at the current sales rate." />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[12.5px]">
              <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">{['Industry', 'Available', 'Sold (30d)', 'Sell-through', 'Days of cover'].map((h) => <th key={h} className="h-9 px-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {v.industries.slice(0, 25).map((i) => (
                  <tr key={i.industry} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-2 font-medium">{i.industry}</td>
                    <td className={cn('tnum px-4', i.available === 0 && 'font-medium text-danger')}>{fmtInt(i.available)}</td>
                    <td className="tnum px-4">{fmtInt(i.sold30)}</td>
                    <td className="px-4"><div className="flex items-center gap-2"><div className="w-20"><Bar value={i.sellThrough} max={100} tone={i.sellThrough >= 50 ? 'bg-ok' : i.sellThrough >= 20 ? 'bg-warn' : 'bg-fg/40'} /></div><span className="tnum text-[11.5px]">{i.sellThrough}%</span></div></td>
                    <td className={cn('tnum px-4', i.daysOfCover != null && i.daysOfCover < 14 ? 'font-medium text-warn' : 'text-muted')}>{i.daysOfCover == null ? '—' : `${i.daysOfCover}d`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="flex flex-col gap-4">
          <Card><CardHeader title="Age of stock" /><CardBody className="flex flex-col gap-2.5">{v.aging.map((a, i) => <div key={a.label} className="flex items-center gap-3 text-[12.5px]"><span className="w-28 text-muted">{a.label}</span><div className="flex-1"><Bar value={a.count} max={maxA} tone={['bg-ok', 'bg-info', 'bg-warn', 'bg-danger'][i]} /></div><span className="tnum w-14 text-right">{fmtInt(a.count)}</span></div>)}</CardBody></Card>
          <Card><CardHeader title="Top regions" /><CardBody className="flex flex-col gap-2">{v.states.map((s) => <div key={s.state} className="flex items-center gap-3 text-[12.5px]"><span className="w-32 truncate text-muted">{s.state}</span><div className="flex-1"><Bar value={s.available} max={maxS} tone="bg-accent" /></div><span className="tnum w-14 text-right">{fmtInt(s.available)}</span></div>)}</CardBody></Card>
        </div>
      </div>
    </div>
  );
}

type Dem = { searches: number; zeroResults: number; searchingClients: number; industries: { value: string; searches: number; stock: number }[]; locations: { value: string; searches: number }[]; keywords: { value: string; searches: number }[]; unmet: { industries: { value: string; searches: number }[]; locations: { value: string; searches: number }[] }; savedSearches: { value: string; searches: number; autoBuy: number }[] };

function DemandList({ title, rows, tone, extra }: { title: string; rows: { value: string; searches: number }[]; tone: string; extra?: (v: string) => React.ReactNode }) {
  const max = Math.max(1, ...rows.map((r) => r.searches));
  return (
    <Card><CardHeader title={title} /><CardBody className="flex flex-col gap-2">
      {rows.length ? rows.map((r) => <div key={r.value} className="flex items-center gap-3 text-[12.5px]"><span className="w-36 truncate">{r.value}</span><div className="flex-1"><Bar value={r.searches} max={max} tone={tone} /></div><span className="tnum w-10 text-right">{fmtInt(r.searches)}</span>{extra?.(r.value)}</div>) : <p className="text-[12px] text-subtle">No data yet.</p>}
    </CardBody></Card>
  );
}

function Demand({ days }: { days: string }) {
  const { data: d } = useApiQuery<Dem>(`/api/v1/insights/demand?days=${days}`);
  if (!d) return <Skeleton className="h-96" />;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile icon={Search} tone="info" label="Client searches" value={fmtInt(d.searches)} sub={`${fmtInt(d.searchingClients)} workspaces searching`} />
        <Tile icon={AlertTriangle} tone="danger" label="Found nothing" value={fmtInt(d.zeroResults)} sub={`${d.searches ? Math.round((d.zeroResults / d.searches) * 100) : 0}% of searches — unmet demand`} />
        <Tile icon={Users} tone="accent" label="Saved-search interests" value={fmtInt(d.savedSearches.reduce((a, s) => a + s.searches, 0))} sub={`${fmtInt(d.savedSearches.reduce((a, s) => a + s.autoBuy, 0))} with auto-buy on`} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <DemandList title="Most searched industries" rows={d.industries} tone="bg-info" extra={(v) => { const s = d.industries.find((x) => x.value === v)!.stock; return <span className={cn('w-20 text-right text-[11px]', s < 20 ? 'font-medium text-danger' : 'text-subtle')}>{fmtInt(s)} in stock</span>; }} />
        <DemandList title="Searched but not found — source these" rows={[...d.unmet.industries, ...d.unmet.locations]} tone="bg-danger" />
        <DemandList title="Most searched locations" rows={d.locations} tone="bg-accent" />
        <DemandList title="Business keywords" rows={d.keywords} tone="bg-warn" />
      </div>
    </div>
  );
}

type Rec = { total: number; buckets: { label: string; count: number; amount: number }[]; invoices: { id: string; code: string; invoiceNumber: string | null; client: string; organizationId: string; amount: number; currency: string; ageDays: number }[]; creditRequests: { id: string; code: string; client: string; amount: number; currency: string; status: string; reported: boolean; ageDays: number }[] };

function Receivables({ currency }: { currency: string }) {
  const { data: r } = useApiQuery<Rec>('/api/v1/insights/receivables');
  if (!r) return <Skeleton className="h-96" />;
  const m = (x: number, c = currency) => money(Math.round(x * 100), c);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {r.buckets.map((b, i) => <Tile key={b.label} icon={Coins} tone={(['ok', 'info', 'warn', 'danger'] as const)[i]} label={b.label} value={m(b.amount)} sub={`${fmtInt(b.count)} invoices`} />)}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Unpaid lead invoices" description={`${m(r.total)} outstanding — oldest first`} actions={<Link href="/admin/marketplace?tab=requests" className="text-[12px] text-info hover:underline">Requests</Link>} />
          <ul className="flex max-h-[420px] flex-col divide-y divide-border overflow-y-auto">
            {r.invoices.map((i) => <li key={i.id} className="flex items-center gap-3 px-4 py-2 text-[12.5px]"><span className="font-mono text-[11.5px] text-subtle">{i.invoiceNumber ?? i.code}</span><Link href={`/admin/organizations/${i.organizationId}`} className="min-w-0 flex-1 truncate hover:underline">{i.client}</Link><span className={cn('tnum text-[11.5px]', i.ageDays > 30 ? 'font-medium text-danger' : i.ageDays > 15 ? 'text-warn' : 'text-subtle')}>{i.ageDays}d</span><span className="tnum w-24 text-right font-medium">{m(i.amount, i.currency)}</span></li>)}
            {!r.invoices.length && <li className="px-4 py-8 text-center text-[12.5px] text-subtle">Nothing outstanding.</li>}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Credit purchases awaiting payment" actions={<Link href="/admin/marketplace?tab=credits" className="text-[12px] text-info hover:underline">Credits</Link>} />
          <ul className="flex max-h-[420px] flex-col divide-y divide-border overflow-y-auto">
            {r.creditRequests.map((c) => <li key={c.id} className="flex items-center gap-3 px-4 py-2 text-[12.5px]"><span className="font-mono text-[11.5px] text-subtle">{c.code}</span><span className="min-w-0 flex-1 truncate">{c.client}</span>{c.reported && <span className="rounded-full bg-ok-dim px-2 text-[10.5px] text-ok">client says paid</span>}<span className="tnum text-[11.5px] text-subtle">{c.ageDays}d</span><span className="tnum w-24 text-right font-medium">{m(c.amount, c.currency)}</span></li>)}
            {!r.creditRequests.length && <li className="px-4 py-8 text-center text-[12.5px] text-subtle">No open credit requests.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}

export function InsightsView() {
  const [s, set] = useUrlState({ tab: 'revenue', days: '30' });
  const pricing = useApiQuery<{ pricing: { currency: string } }>('/api/v1/marketplace/pricing');
  const showDays = s.tab === 'revenue' || s.tab === 'demand';
  return (
    <>
      <PageHeader eyebrow="Business" title="Insights" description="Revenue, stock, what clients are looking for, and who owes what."
        actions={showDays ? <Select className="h-8 w-40 text-[12.5px]" value={s.days} onChange={(e) => set({ days: e.target.value })} aria-label="Period">{[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select> : undefined} />
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}><TabsList className="mb-4"><TabsTrigger value="revenue">Revenue</TabsTrigger><TabsTrigger value="inventory">Inventory</TabsTrigger><TabsTrigger value="demand">Demand</TabsTrigger><TabsTrigger value="receivables">Receivables</TabsTrigger></TabsList></Tabs>
      {s.tab === 'revenue' && <Revenue days={s.days} />}
      {s.tab === 'inventory' && <Inventory />}
      {s.tab === 'demand' && <Demand days={s.days} />}
      {s.tab === 'receivables' && <Receivables currency={pricing.data?.pricing.currency ?? 'INR'} />}
    </>
  );
}
