'use client';
import { ArrowRight, Globe, X } from 'lucide-react';
import { useState } from 'react';
import { BarList, ColumnChart, TrendChart } from '@/components/data/charts';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { buttonClass } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Kpi, KpiGrid } from '@/components/ui/page';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtInt, fmtPct, humanize } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { STRATEGY_INFO } from './strategies';

type Client = { id: string; name: string; industry: string | null; domain: string | null; status: string; received: number; uniqueLeads: number; active: number; returned: number; redistributed: number; contacted: number; converted: number; lost: number; firstContactHours: number | null; batches: number; lastReceived: string | null; share: number };
type Analytics = {
  range: { days: number; from: string };
  kpis: { assignments: number; previousAssignments: number; leads: number; previousLeads: number; clients: number; active: number; revoked: number; reassigned: number; rolledBack: number; redistributed: number; contacted: number; converted: number; firstContactHours: number | null; returnRate: number; contactRate: number; conversionRate: number };
  pool: { ready: number; never: number; returned: number; pending: number; allocated: number };
  series: { points: Record<string, number | string>[]; clients: { key: string; label: string }[] };
  clients: Client[];
  industries: { industry: string; received: number; clients: number; contacted: number; converted: number }[];
  timesDistributed: { bucket: string; leads: number }[];
  matrix: { clients: { id: string; name: string }[]; rows: { source: string; total: number; cells: number[] }[] };
  batches: { strategy: string; mode: string; batches: number; selected: number; allocated: number; failed: number; skipped: number; rolledBack: number }[];
  skipReasons: { reason: string; count: number }[];
};

const RANGES = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '12 months']] as const;
const trend = (cur: number, prev: number) => (prev ? { value: ((cur - prev) / prev) * 100, label: 'vs prior' } : null);
const hrs = (h: number | null) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);

export function DistributionAnalytics({ onDistribute }: { onDistribute: () => void }) {
  const [days, setDays] = useState(30);
  const [org, setOrg] = useState('');
  const [industry, setIndustry] = useState('');
  const { data, error, isFetching } = useApiQuery<Analytics>(`/api/v1/distribution/analytics?days=${days}${org ? `&organizationId=${org}` : ''}${industry ? `&industry=${encodeURIComponent(industry)}` : ''}`);
  const all = useApiQuery<Analytics>(`/api/v1/distribution/analytics?days=${days}`); // unfiltered lists for the pickers
  if (error) return <ErrorState description={errorMessage(error)} />;
  const k = data?.kpis;
  const orgName = all.data?.clients.find((c) => c.id === org)?.name;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border-strong p-0.5">
          {RANGES.map(([d, l]) => <button key={d} type="button" onClick={() => setDays(d)} className={cn('h-7 rounded px-2.5 text-[12px]', days === d ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{l}</button>)}
        </div>
        <Select value={org} onChange={(e) => setOrg(e.target.value)} className="h-8 w-52 text-[12px]" aria-label="Client"><option value="">All clients</option>{(all.data?.clients ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select value={industry} onChange={(e) => setIndustry(e.target.value)} className="h-8 w-52 text-[12px]" aria-label="Client domain"><option value="">All client domains</option>{(all.data?.industries ?? []).map((i) => <option key={i.industry} value={i.industry}>{i.industry}</option>)}</Select>
        {(org || industry) && <button type="button" onClick={() => { setOrg(''); setIndustry(''); }} className="flex items-center gap-1 text-[12px] text-subtle hover:text-fg"><X className="size-3" />Clear{orgName ? ` ${orgName}` : ''}</button>}
        {isFetching && <span className="text-[11.5px] text-subtle">Updating…</span>}
      </div>

      {!data || !k ? <Skeleton className="h-[480px]" /> : (
        <>
          <KpiGrid className="xl:grid-cols-4">
            <Kpi label="Leads distributed" value={fmtInt(k.assignments)} trend={trend(k.assignments, k.previousAssignments)} sub={`${fmtInt(k.leads)} unique leads · ${fmtInt(k.clients)} clients`} />
            <Kpi label="Redistributed" value={fmtInt(k.redistributed)} sub={`${fmtPct(k.assignments ? k.redistributed / k.assignments : 0, 0)} had been with another client`} />
            <Kpi label="Returned / moved" value={fmtPct(k.returnRate, 1)} sub={`${fmtInt(k.revoked)} returned · ${fmtInt(k.reassigned)} moved · ${fmtInt(k.rolledBack)} rolled back`} />
            <Kpi label="Still active" value={fmtInt(k.active)} sub={`${fmtPct(k.assignments ? k.active / k.assignments : 0, 0)} of distributed`} />
            <Kpi label="Contacted by clients" value={fmtPct(k.contactRate, 1)} sub={`${fmtInt(k.contacted)} leads`} />
            <Kpi label="Converted" value={fmtPct(k.conversionRate, 1)} sub={`${fmtInt(k.converted)} leads`} />
            <Kpi label="Avg time to first contact" value={hrs(k.firstContactHours)} sub="after the lead was sent" />
            <Card className="flex flex-col justify-between px-4 py-3.5">
              <div className="eyebrow">Ready to distribute now</div>
              <div className="mt-2 flex items-baseline gap-2"><span className="tnum text-[24px] leading-none font-[520] tracking-[-0.03em]">{fmtInt(data.pool.ready)}</span><span className="text-[11.5px] text-subtle">{fmtInt(data.pool.never)} fresh · {fmtInt(data.pool.returned)} returned</span></div>
              <button type="button" onClick={onDistribute} className={cn(buttonClass({ variant: 'primary', size: 'sm' }), 'mt-2 self-start')}>Distribute <ArrowRight /></button>
            </Card>
          </KpiGrid>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader title="Leads distributed per day" description={data.series.clients.length ? 'Total, plus the three busiest clients' : undefined} />
              <CardBody><TrendChart data={data.series.points} xKey="date" series={[{ key: 'total', label: 'All clients' }, ...data.series.clients]} height={240} /></CardBody>
            </Card>
            <Card>
              <CardHeader title="How many times leads were distributed" description="Leads sent in this period, by their all-time count" />
              <CardBody><ColumnChart data={data.timesDistributed.map((t) => ({ ...t, label: `${t.bucket}×` }))} xKey="label" yKey="leads" label="Leads" height={240} /></CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader title="By client" description="Who received what, and what they did with it. Click a client to focus the dashboard." />
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">
                    {['Client', 'Received', 'Share', 'Active', 'Returned', 'Redistributed in', 'Contacted', 'Converted', '1st contact', 'Last received'].map((h) => <th key={h} className="h-9 px-3 font-medium whitespace-nowrap">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.clients.map((c) => (
                    <tr key={c.id} onClick={() => setOrg(org === c.id ? '' : c.id)} className={cn('cursor-pointer border-b border-border/60 last:border-0 hover:bg-surface-2', org === c.id && 'bg-surface-2')}>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2"><span className="font-medium">{c.name}</span>{c.status !== 'ACTIVE' && <StatusBadge status={c.status} />}</div>
                        <div className="flex items-center gap-1 text-[11px] text-subtle">{c.domain && <><Globe className="size-3" />{c.domain} · </>}{c.industry ?? 'No domain set'}</div>
                      </td>
                      <td className="tnum px-3 font-medium">{fmtInt(c.received)}</td>
                      <td className="px-3"><div className="flex w-28 items-center gap-2"><div className="h-1.5 flex-1 rounded-full bg-surface-3"><div className="h-full rounded-full bg-fg" style={{ width: `${c.share * 100}%` }} /></div><span className="tnum w-9 text-right text-[11px] text-subtle">{fmtPct(c.share, 0)}</span></div></td>
                      <td className="tnum px-3">{fmtInt(c.active)}</td>
                      <td className="tnum px-3">{fmtInt(c.returned)}{c.received > 0 && c.returned > 0 && <span className="text-subtle"> · {fmtPct(c.returned / c.received, 0)}</span>}</td>
                      <td className="tnum px-3">{fmtInt(c.redistributed)}</td>
                      <td className="tnum px-3">{fmtPct(c.received ? c.contacted / c.received : 0, 0)}</td>
                      <td className="tnum px-3">{fmtPct(c.received ? c.converted / c.received : 0, 1)}</td>
                      <td className="tnum px-3">{hrs(c.firstContactHours)}</td>
                      <td className="px-3 whitespace-nowrap text-subtle">{fmtAgo(c.lastReceived)}</td>
                    </tr>
                  ))}
                  {!data.clients.length && <tr><td colSpan={10} className="py-10 text-center text-subtle">No distributions in this period.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card>
              <CardHeader title="By client domain" description="Industry of the receiving clients" />
              <CardBody><BarList items={data.industries.map((i) => ({ label: i.industry, value: i.received, sub: `${i.clients} client${i.clients === 1 ? '' : 's'} · ${fmtPct(i.received ? i.converted / i.received : 0, 0)} conv.` }))} onSelect={(l) => setIndustry(industry === l ? '' : l)} /></CardBody>
            </Card>
            <Card className="xl:col-span-2">
              <CardHeader title="Lead source → client" description="Where each client's leads came from" />
              <div className="overflow-x-auto px-4 pb-4">
                {!data.matrix.rows.length ? <div className="py-8 text-center text-xs text-subtle">No data</div> : (
                  <table className="w-full text-[12px]">
                    <thead><tr className="text-left text-[10.5px] text-subtle"><th className="h-8 pr-3 font-medium">Source</th>{data.matrix.clients.map((c) => <th key={c.id} className="max-w-[110px] truncate px-1 text-center font-medium" title={c.name}>{c.name}</th>)}<th className="px-2 text-right font-medium">Total</th></tr></thead>
                    <tbody>
                      {data.matrix.rows.map((r) => {
                        const max = Math.max(1, ...data.matrix.rows.flatMap((x) => x.cells));
                        return (
                          <tr key={r.source}>
                            <td className="truncate py-1 pr-3 text-muted">{r.source}</td>
                            {r.cells.map((v, i) => (
                              <td key={i} className="px-1 py-1">
                                <div className="grid h-8 place-items-center rounded-md text-[11.5px] tabular-nums" style={{ background: v ? `color-mix(in srgb, var(--fg) ${Math.round(8 + (v / max) * 72)}%, transparent)` : 'var(--surface-2)', color: v / max > 0.55 ? 'var(--inverse)' : 'var(--fg-2)' }}>{v || '·'}</div>
                              </td>
                            ))}
                            <td className="tnum px-2 text-right">{fmtInt(r.total)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader title="Batch performance" description="By strategy and mode" />
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">{['Strategy', 'Batches', 'Selected', 'Sent', 'Success', 'Skipped', 'Failed', 'Rolled back'].map((h) => <th key={h} className="h-9 px-3 font-medium">{h}</th>)}</tr></thead>
                  <tbody>
                    {data.batches.map((b) => (
                      <tr key={`${b.strategy}-${b.mode}`} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-2">{STRATEGY_INFO[b.strategy]?.label ?? humanize(b.strategy)}{b.mode !== 'MANUAL' && <Badge tone="outline" className="ml-1.5">{humanize(b.mode)}</Badge>}</td>
                        <td className="tnum px-3">{fmtInt(b.batches)}</td>
                        <td className="tnum px-3">{fmtInt(b.selected)}</td>
                        <td className="tnum px-3 font-medium">{fmtInt(b.allocated)}</td>
                        <td className="tnum px-3">{fmtPct(b.selected ? b.allocated / b.selected : 0, 0)}</td>
                        <td className="tnum px-3 text-muted">{fmtInt(b.skipped)}</td>
                        <td className={cn('tnum px-3', b.failed ? 'text-danger' : 'text-muted')}>{fmtInt(b.failed)}</td>
                        <td className="tnum px-3 text-muted">{fmtInt(b.rolledBack)}</td>
                      </tr>
                    ))}
                    {!data.batches.length && <tr><td colSpan={8} className="py-8 text-center text-subtle">No batches in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card>
              <CardHeader title="Why leads weren't sent" description="Skipped or failed batch items" />
              <CardBody><BarList items={data.skipReasons.map((r) => ({ label: r.reason, value: r.count }))} empty="Nothing skipped" /></CardBody>
            </Card>
          </div>
          <p className="text-[11px] text-subtle">Contact and conversion figures come from the clients&apos; own pipelines for leads sent in this period. Returned = revoked, reassigned or rolled back.</p>
        </>
      )}
    </div>
  );
}
