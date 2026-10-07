'use client';
import Link from 'next/link';
import { BarList, ColumnChart, Funnel, Meter } from '@/components/data/charts';
import { RangeFilter, rangeToQuery, type RangeState } from '@/components/data/range-filter';
import { ReportBuilder } from '@/components/data/report-builder';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader, Section } from '@/components/ui/page';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { errorMessage } from '@/lib/api-client';
import { fmtInt, fmtPct, humanize } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';

type A = {
  imports: { day: string; inserted: number; updated: number; invalid: number; files: number }[];
  campaigns: { campaign: string; leads: number; allocated: number; contacted: number; converted: number }[];
  sources: { source: string; leads: number; invalid: number; allocated: number; converted: number }[];
  efficiency: { avgHoursToAllocate: number | null; p50: number | null; p90: number | null };
  clients: { id: string; name: string; allocated: number; contacted: number; qualified: number; converted: number; lost: number; contactRate: number | null; qualificationRate: number | null; conversionRate: number | null; firstResponseHours: number | null; followUpCompliance: number | null; comms: number; utilization: number | null }[];
  cohorts: { week: string; size: number; contacted: number | null; qualified: number | null; converted: number | null }[];
  comparison: { current: Record<string, number>; previous: Record<string, number> };
  funnel: { stage: string; value: number }[];
};

const hrs = (raw: number | string | null) => { const h = raw == null ? null : Number(raw); return h == null || !Number.isFinite(h) ? '—' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`; };

export function PlatformAnalytics({ canExport }: { canExport: boolean }) {
  const [state, set] = useUrlState<RangeState>({ range: '30', from: undefined, to: undefined, orgs: undefined, sources: undefined, campaigns: undefined });
  const facets = useApiQuery<{ sources: string[]; campaigns: string[]; orgs: { id: string; name: string }[] }>('/api/v1/leads/facets');
  const { data, error, isLoading } = useApiQuery<A>(`/api/v1/analytics/platform?${rangeToQuery(state)}`);
  return (
    <>
      <PageHeader title="Analytics" description="Import quality, distribution efficiency and client outcomes. Client-level figures are aggregates; no tenant’s records are exposed to another." />
      <RangeFilter state={state} onChange={set} facets={facets.data} />
      {error ? <ErrorState description={errorMessage(error)} /> : isLoading || !data ? <Skeleton className="h-96" /> : (
        <>
          <Section title="Period comparison" description="Selected period versus the preceding period of equal length">
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
              {Object.keys(data.comparison.current).map((k) => {
                const c = data.comparison.current[k], p = data.comparison.previous[k];
                const d = p ? ((c - p) / p) * 100 : null;
                return (
                  <div key={k} className="rounded-lg border border-border bg-surface px-4 py-3">
                    <div className="eyebrow">{humanize(k)}</div>
                    <div className="mt-2 flex items-baseline gap-2"><span className="tnum text-[22px] tracking-tight">{fmtInt(c)}</span>{d != null && <span className="tnum text-[11px] text-subtle">{d >= 0 ? '↑' : '↓'} {Math.abs(d).toFixed(0)}%</span>}</div>
                    <div className="mt-1 text-[11px] text-subtle">prev {fmtInt(p)}</div>
                  </div>
                );
              })}
            </div>
          </Section>
          <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2"><CardHeader title="Import volume" description="Leads inserted per day from completed imports" /><CardBody><ColumnChart data={data.imports} xKey="day" yKey="inserted" label="Inserted" /></CardBody></Card>
            <Card><CardHeader title="Funnel" description="Leads allocated in period" /><CardBody className="flex flex-col gap-5">
              <Funnel steps={data.funnel} />
              <div className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-center text-[11px] text-subtle">
                <div><div className="tnum text-[15px] text-fg">{hrs(data.efficiency.p50)}</div>median time to allocate</div>
                <div><div className="tnum text-[15px] text-fg">{hrs(data.efficiency.p90)}</div>p90 time to allocate</div>
                <div><div className="tnum text-[15px] text-fg">{hrs(data.efficiency.avgHoursToAllocate)}</div>mean</div>
              </div>
            </CardBody></Card>
          </div>
          <Section title="Client performance" description="Rates are relative to leads allocated in the period. Contact and conversion events are self-reported by client users.">
            <Card>
              <SimpleTable rows={data.clients} columns={[
                { key: 'name', header: 'Client', render: (r) => <Link className="text-fg hover:underline" href={`/admin/organizations/${r.id}`}>{r.name}</Link> },
                { key: 'allocated', header: 'Allocated', className: 'tnum text-right', render: (r) => fmtInt(r.allocated) },
                { key: 'utilization', header: 'Capacity', render: (r) => <Meter value={r.utilization} /> },
                { key: 'contactRate', header: 'Contact', className: 'tnum text-right', render: (r) => fmtPct(r.contactRate, 0) },
                { key: 'qualificationRate', header: 'Qualified', className: 'tnum text-right', render: (r) => fmtPct(r.qualificationRate, 0) },
                { key: 'conversionRate', header: 'Converted', className: 'tnum text-right', render: (r) => fmtPct(r.conversionRate, 1) },
                { key: 'firstResponseHours', header: 'First response', className: 'tnum text-right', render: (r) => hrs(r.firstResponseHours) },
                { key: 'followUpCompliance', header: 'Follow-up', className: 'tnum text-right', render: (r) => fmtPct(r.followUpCompliance, 0) },
                { key: 'comms', header: 'Activity', className: 'tnum text-right', render: (r) => fmtInt(r.comms) },
              ]} />
            </Card>
          </Section>
          <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card><CardHeader title="Lead sources" description="Created in period · converted shown alongside" /><CardBody><BarList items={data.sources.map((s) => ({ label: s.source, value: s.leads, sub: `${s.invalid} invalid · ${s.converted} won` }))} /></CardBody></Card>
            <Card><CardHeader title="Campaigns" /><CardBody><BarList items={data.campaigns.map((c) => ({ label: c.campaign, value: c.leads, sub: `${fmtPct(c.allocated ? c.converted / c.allocated : null, 0)} conv.` }))} /></CardBody></Card>
          </div>
          <Section title="Weekly cohorts" description="Leads grouped by the week they were allocated, and what share has progressed since">
            <Card><SimpleTable rows={data.cohorts.map((c) => ({ ...c, id: c.week }))} columns={[
              { key: 'week', header: 'Week of' }, { key: 'size', header: 'Leads', className: 'tnum text-right', render: (r) => fmtInt(r.size) },
              ...(['contacted', 'qualified', 'converted'] as const).map((k) => ({ key: k, header: humanize(k), className: 'tnum text-right', render: (r: A['cohorts'][number]) => <span style={{ opacity: 0.45 + 0.55 * (r[k] ?? 0) }}>{fmtPct(r[k], 0)}</span> })),
            ]} /></Card>
          </Section>
          <Section title="Report builder"><ReportBuilder canExport={canExport} /></Section>
        </>
      )}
    </>
  );
}
