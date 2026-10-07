'use client';
import { Clock, Coins, Gauge, Hourglass, PhoneCall, Target, TrendingUp, Trophy, Users, Wallet } from 'lucide-react';
import Link from 'next/link';
import { TrendChart } from '@/components/data/charts';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtInt } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';
import { money } from '@/lib/pricing';

type Row = { key: string; leads: number; contacted: number; won: number; revenue: number; medianHoursToContact: number | null; winRate: number };
type Roi = {
  days: number; currency: string; dealCurrency: string; slaHours: number; scopedToMe: boolean;
  spend: { total: number; invoiced: number; credits: number; creditValue: number };
  funnel: { leads: number; purchased: number; free: number; contacted: number; qualified: number; won: number; lost: number };
  rates: { contactRate: number; qualifyRate: number; winRate: number };
  value: { revenue: number; pipeline: number; roi: number | null; costPerLead: number | null; costPerWin: number | null };
  speed: { medianHours: number | null; withinSlaPct: number; uncontacted: { total: number; under24h: number; d1to3: number; over3d: number } };
  byIndustry: Row[]; byRep: Row[]; byMonth: { month: string; leads: number; contacted: number; won: number; revenue: number }[];
};

const TONES = { ok: 'bg-ok-dim text-ok', info: 'bg-info-dim text-info', accent: 'bg-accent-dim text-accent', warn: 'bg-warn-dim text-warn', danger: 'bg-danger-dim text-danger' } as const;
const hrs = (h: number | null) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h * 10) / 10}h` : `${Math.round(h / 24)}d`);

function Tile({ icon: I, tone, label, value, sub, big }: { icon: React.ComponentType<{ className?: string }>; tone: keyof typeof TONES; label: string; value: React.ReactNode; sub?: React.ReactNode; big?: boolean }) {
  return (
    <Card className={cn('flex flex-col gap-2 px-4 py-3.5', big && 'border-ok/30')}>
      <div className="flex items-center justify-between"><span className="eyebrow">{label}</span><span className={cn('grid size-7 place-items-center rounded-md', TONES[tone])}><I className="size-3.5" /></span></div>
      <div className={cn('tnum leading-none font-semibold tracking-[-0.03em]', big ? 'text-[30px]' : 'text-[24px]')}>{value}</div>
      {sub && <div className="text-[11.5px] text-subtle">{sub}</div>}
    </Card>
  );
}

function Breakdown({ title, rows, cur, empty }: { title: string; rows: Row[]; cur: string; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.leads));
  return (
    <Card>
      <CardHeader title={title} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[12.5px]">
          <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">{['', 'Leads', 'Contacted', 'Won', 'Win rate', 'Revenue', 'Speed'].map((h, i) => <th key={i} className="h-9 px-4 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2.5"><div className="font-medium">{r.key || '—'}</div><div className="mt-1 h-1 w-28 rounded-full bg-surface-3"><div className="h-full rounded-full bg-info" style={{ width: `${(r.leads / max) * 100}%` }} /></div></td>
                <td className="tnum px-4">{fmtInt(r.leads)}</td>
                <td className="tnum px-4">{fmtInt(r.contacted)} <span className="text-subtle">({r.leads ? Math.round((r.contacted / r.leads) * 100) : 0}%)</span></td>
                <td className="tnum px-4 font-medium text-ok">{fmtInt(r.won)}</td>
                <td className="tnum px-4">{r.winRate}%</td>
                <td className="tnum px-4">{money(Math.round(r.revenue * 100), cur)}</td>
                <td className="tnum px-4 text-muted">{hrs(r.medianHoursToContact)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="py-8 text-center text-subtle">{empty}</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function RoiView() {
  const [s, set] = useUrlState({ days: '90' });
  const { data: r, error } = useApiQuery<Roi>(`/api/v1/crm/roi?days=${s.days}`);
  if (error) return <ErrorState description={errorMessage(error)} />;
  const cur = r?.currency ?? 'USD';
  const dc = r?.dealCurrency ?? cur;
  return (
    <>
      <PageHeader eyebrow="Performance" title="Lead ROI" description="What you spent on leads, how fast your team worked them, and what they turned into."
        actions={<Select className="h-8 w-40 text-[12.5px]" value={s.days} onChange={(e) => set({ days: e.target.value })} aria-label="Period">{[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', 'Last 6 months'], ['365', 'Last 12 months']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>} />
      {!r ? <Skeleton className="h-96" /> : (
        <div className="flex flex-col gap-4">
          {r.scopedToMe && <p className="text-[12px] text-subtle">Showing the leads assigned to you.</p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Tile big icon={TrendingUp} tone="ok" label="Return on spend" value={r.value.roi == null ? '—' : `${r.value.roi}×`} sub={r.value.roi == null ? 'Record deal values on won leads to see ROI' : `${money(Math.round(r.value.revenue * 100), dc)} won from ${money(Math.round(r.spend.total * 100), cur)} spent`} />
            <Tile icon={Wallet} tone="accent" label="Spent on leads" value={money(Math.round(r.spend.total * 100), cur)} sub={[r.spend.invoiced ? `${money(Math.round(r.spend.invoiced * 100), cur)} invoiced` : null, r.spend.credits ? `${fmtInt(r.spend.credits)} credits` : null].filter(Boolean).join(' · ') || 'No purchases in this period'} />
            <Tile icon={Trophy} tone="ok" label="Deals won" value={fmtInt(r.funnel.won)} sub={`${r.rates.winRate}% win rate · ${money(Math.round(r.value.pipeline * 100), dc)} open pipeline`} />
            <Tile icon={Coins} tone="info" label="Cost per won deal" value={r.value.costPerWin == null ? '—' : money(Math.round(r.value.costPerWin * 100), cur)} sub={r.value.costPerLead == null ? '—' : `${money(Math.round(r.value.costPerLead * 100), cur)} per purchased lead`} />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader title="From lead to deal" description={`${fmtInt(r.funnel.leads)} leads received · ${fmtInt(r.funnel.purchased)} purchased, ${fmtInt(r.funnel.free)} free`} />
              <CardBody className="flex flex-col gap-2.5">
                {([['Received', r.funnel.leads, 'bg-info'], ['Contacted', r.funnel.contacted, 'bg-accent'], ['Qualified', r.funnel.qualified, 'bg-warn'], ['Won', r.funnel.won, 'bg-ok']] as const).map(([k, v, c]) => (
                  <div key={k} className="flex items-center gap-3 text-[12.5px]">
                    <span className="w-20 shrink-0 text-muted">{k}</span>
                    <div className="h-7 flex-1 overflow-hidden rounded-md bg-surface-2"><div className={cn('flex h-full items-center rounded-md px-2 text-[11.5px] font-medium text-white', c)} style={{ width: `${Math.max(r.funnel.leads ? (v / r.funnel.leads) * 100 : 0, v ? 6 : 0)}%` }}>{v ? fmtInt(v) : ''}</div></div>
                    <span className="tnum w-12 text-right text-subtle">{r.funnel.leads ? Math.round((v / r.funnel.leads) * 100) : 0}%</span>
                  </div>
                ))}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Speed to lead" description={`Your first-contact target is ${r.slaHours}h`} />
              <CardBody className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-border px-3 py-2.5"><div className="flex items-center gap-1.5 text-[11px] text-subtle"><Clock className="size-3" />Median first contact</div><div className="tnum mt-1 text-[22px] font-semibold">{hrs(r.speed.medianHours)}</div></div>
                  <div className="rounded-lg border border-border px-3 py-2.5"><div className="flex items-center gap-1.5 text-[11px] text-subtle"><Gauge className="size-3" />Within target</div><div className={cn('tnum mt-1 text-[22px] font-semibold', r.speed.withinSlaPct >= 80 ? 'text-ok' : r.speed.withinSlaPct >= 50 ? 'text-warn' : 'text-danger')}>{r.speed.withinSlaPct}%</div></div>
                </div>
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[12px]"><span className="flex items-center gap-1.5 font-medium"><Hourglass className="size-3.5 text-warn" />Waiting for first contact</span><span className="tnum">{fmtInt(r.speed.uncontacted.total)}</span></div>
                  <div className="flex h-2 overflow-hidden rounded-full bg-surface-3">
                    {[[r.speed.uncontacted.under24h, 'bg-ok'], [r.speed.uncontacted.d1to3, 'bg-warn'], [r.speed.uncontacted.over3d, 'bg-danger']].map(([v, c], i) => <div key={i} className={String(c)} style={{ width: `${r.speed.uncontacted.total ? (Number(v) / r.speed.uncontacted.total) * 100 : 0}%` }} />)}
                  </div>
                  <div className="mt-1.5 flex justify-between text-[11px] text-subtle"><span className="text-ok">{r.speed.uncontacted.under24h} under 24h</span><span className="text-warn">{r.speed.uncontacted.d1to3} 1–3 days</span><span className="text-danger">{r.speed.uncontacted.over3d} over 3 days</span></div>
                </div>
                {r.speed.uncontacted.total > 0 && <Link href="/app/today" className="inline-flex items-center gap-1.5 self-start rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-inverse"><PhoneCall className="size-3.5" />Work them now in Today</Link>}
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader title="Monthly cohorts" description="Leads received each month and what became of them" />
            <CardBody><TrendChart data={r.byMonth} xKey="month" series={[{ key: 'leads', label: 'Leads' }, { key: 'contacted', label: 'Contacted' }, { key: 'won', label: 'Won' }]} height={220} /></CardBody>
          </Card>

          <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
            <Breakdown title="By industry" rows={r.byIndustry} cur={dc} empty="No leads in this period" />
            {!r.scopedToMe && <Breakdown title="By rep" rows={r.byRep} cur={dc} empty="No leads in this period" />}
          </div>
          <p className="flex items-center gap-1.5 text-[11.5px] text-subtle"><Target className="size-3.5" />Revenue counts deal values on leads marked Won. Credits are valued at {money(Math.round(r.spend.creditValue * 100), cur)} each. <Users className="ml-1 size-3.5" />Workspace admins get this summary by email every Monday.</p>
        </div>
      )}
    </>
  );
}
