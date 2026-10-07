'use client';
import { Activity, AlertTriangle, ArrowUpRight, CircleCheck, CircleX, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { BarList, Funnel, Meter, TrendChart } from '@/components/data/charts';
import { RangeFilter, rangeToQuery, type RangeState } from '@/components/data/range-filter';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DemoDataNotice, Kpi, KpiGrid, PageHeader } from '@/components/ui/page';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { fmtAgo, fmtInt, fmtPct, humanize } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';

type Overview = {
  leads: Record<string, number> & { importedTrend: number | null };
  clients: Record<string, number>;
  users: number;
  activeSessions: number;
  distribution: Record<string, number> & { allocatedTrend: number | null; batches: Record<string, number> };
  conversion: { total: number; contacted: number; qualified: number; converted: number; lost: number; convertedInRange: number; contactRate: number | null; qualificationRate: number | null; conversionRate: number | null; avgFirstResponseHours: number | null };
  followUp: { withFollowUp: number; overdue: number; compliance: number | null };
  aging: { bucket: string; uncontacted: number; unallocated: number }[];
  trend: { day: string; imported: number; allocated: number; contacted: number; converted: number }[];
  clientTable: { id: string; name: string; status: string; active: number; contacted: number; converted: number; overdue: number; utilization: number | null; contactRate: number | null; conversionRate: number | null; lastActivity: string | null; allocatedInRange: number }[];
  sources: { source: string; leads: number; allocated: number; converted: number }[];
  recentEvents: { id: string; action: string; actorEmail: string | null; targetType: string | null; result: string; createdAt: string }[];
  security: { alerts: { id: string; title: string; severity: string; status: string; createdAt: string }[]; open: Record<string, number>; failedLogins24h: number };
  failures: { imports: { id: string; code: string; fileName: string; error: string | null; createdAt: string }[]; jobs: number };
};
type Health = { checks: { name: string; ok: boolean; detail: string }[]; queues: { name: string; waiting: number; active: number; failed: number; delayed: number }[] };
type Facets = { sources: string[]; campaigns: string[]; orgs: { id: string; name: string }[] };

export function CommandCenter({ name, demo, canSecurity, canAudit }: { name: string; demo: boolean; canSecurity: boolean; canAudit: boolean }) {
  const [state, set] = useUrlState<RangeState>({ range: '30', from: undefined, to: undefined, orgs: undefined, sources: undefined, campaigns: undefined });
  const q = rangeToQuery(state);
  const { data, isLoading, error } = useApiQuery<Overview>(`/api/v1/admin/overview?${q}`);
  const health = useApiQuery<Health>('/api/v1/admin/health', { refetchInterval: 30_000 });
  const facets = useApiQuery<Facets>('/api/v1/leads/facets');
  const hour = new Date().getHours();

  return (
    <>
      <PageHeader eyebrow="Command center" title={`Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${name}`} description="Platform-wide lead operations, client performance and system health." />
      {demo && <DemoDataNotice />}
      <RangeFilter state={state} onChange={set} facets={facets.data} savedScope="ADMIN_DASHBOARD" />
      {error ? <ErrorState description={(error as Error).message} /> : !data || isLoading ? <LoadingGrid /> : (
        <div className="flex flex-col gap-4">
          <KpiGrid>
            <Kpi label="Total leads" value={fmtInt(data.leads.total)} sub={`${fmtInt(data.leads.imported_in_range)} imported in period`} trend={data.leads.importedTrend != null ? { value: data.leads.importedTrend, label: 'vs prior' } : null} href="/admin/leads" />
            <Kpi label="Unallocated" value={fmtInt(data.leads.unallocated)} sub={`${fmtInt(data.leads.pending)} pending in batches`} href={`/admin/leads?filter=${encodeURIComponent(JSON.stringify({ conditions: [{ field: 'allocationStatus', op: 'in', value: ['UNALLOCATED'] }] }))}`} />
            <Kpi label="Allocated" value={fmtInt(data.leads.allocated)} sub={`${fmtInt(data.distribution.allocated_in_range)} in period · ${data.distribution.clients_served} clients`} trend={data.distribution.allocatedTrend != null ? { value: data.distribution.allocatedTrend, label: 'vs prior' } : null} href="/admin/distribution" />
            <Kpi label="Conversion rate" value={fmtPct(data.conversion.conversionRate)} sub={`${fmtInt(data.conversion.converted)} converted · ${fmtInt(data.conversion.convertedInRange)} in period`} href="/admin/analytics" />
            <Kpi label="Clients" value={fmtInt(data.clients.ACTIVE ?? 0)} sub={`${data.clients.SUSPENDED ?? 0} suspended · ${data.clients.INACTIVE ?? 0} inactive`} href="/admin/organizations" />
            <Kpi label="Users" value={fmtInt(data.users)} sub={`${fmtInt(data.activeSessions)} active sessions`} href="/admin/users" />
          </KpiGrid>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title="Lead flow" description="Imported, allocated, first contact and conversions per day" />
              <CardBody>
                <TrendChart
                  data={data.trend}
                  series={[{ key: 'imported', label: 'Imported' }, { key: 'allocated', label: 'Allocated' }, { key: 'contacted', label: 'First contact' }, { key: 'converted', label: 'Converted' }]}
                />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Lead quality" description="Current repository state" />
              <CardBody className="flex flex-col gap-4">
                <BarList items={[
                  { label: 'Valid', value: data.leads.valid },
                  { label: 'Invalid', value: data.leads.invalid },
                  { label: 'Flagged duplicates', value: data.leads.duplicate },
                  { label: 'Archived', value: data.leads.archived },
                ]} max={Math.max(1, data.leads.total + data.leads.archived)} />
                <div className="border-t border-border pt-3">
                  <div className="eyebrow mb-2">Client funnel (all time)</div>
                  <Funnel steps={[
                    { stage: 'Allocated', value: data.conversion.total },
                    { stage: 'Contacted', value: data.conversion.contacted },
                    { stage: 'Qualified', value: data.conversion.qualified },
                    { stage: 'Converted', value: data.conversion.converted },
                  ]} />
                </div>
              </CardBody>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title="Client performance" description="Active allocations and engagement by organization" actions={<Link href="/admin/organizations" className="text-xs text-subtle hover:text-fg">All clients →</Link>} />
              <SimpleTable
                rows={data.clientTable}
                columns={[
                  { key: 'name', header: 'Client', render: (r) => <Link href={`/admin/organizations/${r.id}`} className="text-fg hover:underline">{r.name}</Link> },
                  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
                  { key: 'active', header: 'Active', className: 'tnum text-right', render: (r) => fmtInt(r.active) },
                  { key: 'util', header: 'Capacity', render: (r) => <Meter value={r.utilization} /> },
                  { key: 'contactRate', header: 'Contacted', className: 'tnum text-right', render: (r) => fmtPct(r.contactRate, 0) },
                  { key: 'conversionRate', header: 'Converted', className: 'tnum text-right', render: (r) => fmtPct(r.conversionRate, 1) },
                  { key: 'overdue', header: 'Overdue F/U', className: 'tnum text-right', render: (r) => (r.overdue ? <span className="text-warn">{fmtInt(r.overdue)}</span> : '0') },
                  { key: 'lastActivity', header: 'Last activity', render: (r) => <span className="text-subtle">{r.lastActivity ? fmtAgo(r.lastActivity) : '—'}</span> },
                ]}
              />
            </Card>
            <Card>
              <CardHeader title="Lead aging" description="Waiting time, by bucket" />
              <CardBody>
                <SimpleTable
                  rows={data.aging}
                  columns={[
                    { key: 'bucket', header: 'Age' },
                    { key: 'unallocated', header: 'Unallocated', className: 'tnum text-right', render: (r) => fmtInt(r.unallocated) },
                    { key: 'uncontacted', header: 'Allocated, no contact', className: 'tnum text-right', render: (r) => (r.uncontacted ? <span className={r.bucket.startsWith('<') ? '' : 'text-warn'}>{fmtInt(r.uncontacted)}</span> : '0') },
                  ]}
                />
                <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-3 text-[12px]">
                  <div><div className="eyebrow">Follow-up compliance</div><div className="tnum mt-1 text-lg">{fmtPct(data.followUp.compliance, 0)}</div><div className="text-[11px] text-subtle">{fmtInt(data.followUp.overdue)} overdue of {fmtInt(data.followUp.withFollowUp)}</div></div>
                  <div><div className="eyebrow">First response</div><div className="tnum mt-1 text-lg">{data.conversion.avgFirstResponseHours == null ? '—' : `${data.conversion.avgFirstResponseHours.toFixed(1)} h`}</div><div className="text-[11px] text-subtle">avg, first recorded contact</div></div>
                </div>
              </CardBody>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardHeader title="Top sources" description="Leads created in period" />
              <CardBody><BarList items={data.sources.map((s) => ({ label: s.source, value: s.leads, sub: s.converted ? `${s.converted} won` : undefined }))} empty="No leads in this period" /></CardBody>
            </Card>
            <Card>
              <CardHeader title="Security" actions={canSecurity ? <Link href="/admin/security" className="text-xs text-subtle hover:text-fg">Open →</Link> : null} />
              <CardBody className="flex flex-col gap-3">
                <div className="flex gap-4 text-[12px]">
                  <div><div className="eyebrow">Open alerts</div><div className="tnum mt-1 text-lg">{Object.values(data.security.open).reduce((a, b) => a + b, 0)}</div></div>
                  <div><div className="eyebrow">Failed logins 24h</div><div className="tnum mt-1 text-lg">{fmtInt(data.security.failedLogins24h)}</div></div>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {data.security.alerts.length === 0 && <li className="flex items-center gap-2 text-xs text-subtle"><CircleCheck className="size-3.5" /> No open alerts</li>}
                  {data.security.alerts.map((a) => (
                    <li key={a.id}>
                      <Link href={`/admin/security/alerts/${a.id}`} className="flex items-start gap-2 rounded px-1 py-1 text-[12px] hover:bg-surface-2">
                        <ShieldAlert className={`mt-0.5 size-3.5 shrink-0 ${a.severity === 'HIGH' || a.severity === 'CRITICAL' ? 'text-danger' : 'text-subtle'}`} />
                        <span className="min-w-0 flex-1 truncate">{a.title}</span>
                        <span className="shrink-0 text-[10.5px] text-subtle">{fmtAgo(a.createdAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Failures" description="Imports and background jobs" />
              <CardBody className="flex flex-col gap-2 text-[12px]">
                <div className="flex items-center justify-between"><span className="text-muted">Job failures (open alerts)</span><span className={`tnum ${data.failures.jobs ? 'text-danger' : ''}`}>{data.failures.jobs}</span></div>
                {data.failures.imports.length === 0 ? <div className="flex items-center gap-2 text-xs text-subtle"><CircleCheck className="size-3.5" /> No failed imports recently</div> : data.failures.imports.map((f) => (
                  <Link key={f.id} href={`/admin/imports/${f.id}`} className="flex items-start gap-2 rounded px-1 py-1 hover:bg-surface-2">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" />
                    <span className="min-w-0"><span className="block truncate">{f.fileName}</span><span className="block truncate text-[11px] text-subtle">{f.error}</span></span>
                  </Link>
                ))}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="System health" description="Refreshes every 30s" />
              <CardBody className="flex flex-col gap-2">
                {health.data?.checks.map((c) => (
                  <div key={c.name} className="flex items-start gap-2 text-[12px]">
                    {c.ok ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-ok" /> : <CircleX className="mt-0.5 size-3.5 shrink-0 text-danger" />}
                    <span className="min-w-0 flex-1"><span className="block">{c.name}</span><span className="block truncate text-[11px] text-subtle">{c.detail}</span></span>
                  </div>
                ))}
                {health.data && (
                  <div className="mt-1 border-t border-border pt-2 text-[11px] text-subtle">
                    Queues: {health.data.queues.map((q) => `${q.name} ${q.waiting + q.active}${q.failed ? ` (${q.failed} failed)` : ''}`).join(' · ')}
                  </div>
                )}
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader title="Recent administrative events" actions={canAudit ? <Link href="/admin/audit" className="flex items-center gap-1 text-xs text-subtle hover:text-fg">Audit log <ArrowUpRight className="size-3" /></Link> : null} />
            <SimpleTable
              rows={data.recentEvents}
              empty={<div className="flex items-center justify-center gap-2 py-8 text-xs text-subtle"><Activity className="size-3.5" /> No events yet</div>}
              columns={[
                { key: 'action', header: 'Action', render: (r) => <span className="font-mono text-[11.5px]">{r.action}</span> },
                { key: 'actorEmail', header: 'Actor', render: (r) => r.actorEmail ?? 'System' },
                { key: 'targetType', header: 'Target', render: (r) => humanize(r.targetType) },
                { key: 'result', header: 'Result', render: (r) => <StatusBadge status={r.result} /> },
                { key: 'createdAt', header: 'When', render: (r) => <span className="text-subtle">{fmtAgo(r.createdAt)}</span> },
              ]}
            />
          </Card>
          {Object.keys(data.distribution.batches).length > 0 && (
            <div className="flex flex-wrap gap-2 text-[11.5px] text-subtle">
              Batches in period: {Object.entries(data.distribution.batches).map(([k, v]) => <Badge key={k} tone="outline">{humanize(k)} · {v}</Badge>)}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function LoadingGrid() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[92px] rounded-lg" />)}</div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3"><Skeleton className="h-[300px] rounded-lg xl:col-span-2" /><Skeleton className="h-[300px] rounded-lg" /></div>
    </div>
  );
}
