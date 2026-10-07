'use client';
import { BarList, TrendChart } from '@/components/data/charts';
import { RangeFilter, rangeToQuery, type RangeState } from '@/components/data/range-filter';
import { ReportBuilder } from '@/components/data/report-builder';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Kpi, PageHeader, Section } from '@/components/ui/page';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { errorMessage } from '@/lib/api-client';
import { fmtInt, fmtMoney, fmtPct } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';

type Rates = { acquired: number; contacted: number; qualified: number; converted: number; lost: number; contactRate: number | null; qualificationRate: number | null; conversionRate: number | null; firstResponseHours: number | null; followUpCompliance: number | null };
type A = {
  trend: { day: string; acquired: number; contacted: number; converted: number }[];
  current: Rates; previous: Rates;
  sources: { source: string; leads: number; contacted: number; converted: number; contactRate: number | null; conversionRate: number | null; value: number }[];
  people: { name: string; leads: number; contacted: number; converted: number; comms: number; tasksDone: number; value: number }[];
  lostReasons: { reason: string; count: number }[];
  pipeline: { name: string; count: number; value: number; weighted: number }[];
};

const delta = (c: number | null, p: number | null) => (c != null && p != null && p > 0 ? { value: ((c - p) / p) * 100, label: 'vs prior' } : null);
const hrs = (raw: number | string | null) => { const h = raw == null ? null : Number(raw); return h == null || !Number.isFinite(h) ? '—' : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`; };

export function ClientAnalytics() {
  const [state, set] = useUrlState<RangeState>({ range: '30', from: undefined, to: undefined });
  const q = rangeToQuery(state);
  const { data, error } = useApiQuery<A>(`/api/v1/crm/analytics?${q}`);
  return (
    <>
      <PageHeader title="Analytics" description="Your workspace only. Contact and conversion figures are based on activity your team logged." />
      <RangeFilter state={state} onChange={set} />
      {error ? <ErrorState description={errorMessage(error)} /> : !data ? <Skeleton className="h-96" /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Leads acquired" value={fmtInt(data.current.acquired)} trend={delta(data.current.acquired, data.previous.acquired)} />
            <Kpi label="Contact rate" value={fmtPct(data.current.contactRate, 0)} sub={`${fmtInt(data.current.contacted)} contacted`} />
            <Kpi label="Qualification rate" value={fmtPct(data.current.qualificationRate, 0)} />
            <Kpi label="Conversion rate" value={fmtPct(data.current.conversionRate, 1)} sub={`${fmtInt(data.current.converted)} converted`} trend={delta(data.current.conversionRate, data.previous.conversionRate)} />
            <Kpi label="First response" value={hrs(data.current.firstResponseHours)} sub="avg to first logged contact" />
            <Kpi label="Follow-up compliance" value={fmtPct(data.current.followUpCompliance, 0)} sub="follow-ups not overdue" />
          </div>
          <Card className="mb-4"><CardHeader title="Trend" /><CardBody><TrendChart data={data.trend} series={[{ key: 'acquired', label: 'Acquired' }, { key: 'contacted', label: 'First contact' }, { key: 'converted', label: 'Converted' }]} /></CardBody></Card>
          <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2"><CardHeader title="Lead source performance" />
              <SimpleTable rows={data.sources.map((s) => ({ ...s, id: s.source }))} columns={[
                { key: 'source', header: 'Source' }, { key: 'leads', header: 'Leads', className: 'tnum text-right', render: (r) => fmtInt(r.leads) },
                { key: 'contactRate', header: 'Contacted', className: 'tnum text-right', render: (r) => fmtPct(r.contactRate, 0) },
                { key: 'conversionRate', header: 'Converted', className: 'tnum text-right', render: (r) => fmtPct(r.conversionRate, 1) },
                { key: 'value', header: 'Won value', className: 'tnum text-right', render: (r) => fmtMoney(r.value) },
              ]} />
            </Card>
            <Card><CardHeader title="Lost-lead reasons" /><CardBody><BarList items={data.lostReasons.map((l) => ({ label: l.reason, value: l.count }))} empty="No lost leads in this period" /></CardBody></Card>
          </div>
          <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2"><CardHeader title="Employee productivity" description="Self-reported activity within the period" />
              <SimpleTable rows={data.people.map((p, i) => ({ ...p, id: i }))} columns={[
                { key: 'name', header: 'Member' }, { key: 'leads', header: 'Owned', className: 'tnum text-right' }, { key: 'comms', header: 'Contacts', className: 'tnum text-right' },
                { key: 'contacted', header: 'First contacts', className: 'tnum text-right' }, { key: 'converted', header: 'Converted', className: 'tnum text-right' },
                { key: 'tasksDone', header: 'Tasks done', className: 'tnum text-right' }, { key: 'value', header: 'Won value', className: 'tnum text-right', render: (r) => fmtMoney(r.value) },
              ]} />
            </Card>
            <Card><CardHeader title="Open pipeline value" />
              <SimpleTable rows={data.pipeline.map((p) => ({ ...p, id: p.name }))} columns={[
                { key: 'name', header: 'Stage' }, { key: 'count', header: 'Deals', className: 'tnum text-right' },
                { key: 'value', header: 'Value', className: 'tnum text-right', render: (r) => fmtMoney(r.value) }, { key: 'weighted', header: 'Weighted', className: 'tnum text-right', render: (r) => fmtMoney(r.weighted) },
              ]} />
            </Card>
          </div>
          <Section title="Report builder"><ReportBuilder workspace /></Section>
        </>
      )}
    </>
  );
}
