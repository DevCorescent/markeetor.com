'use client';
import Link from 'next/link';
import { BarList, Funnel } from '@/components/data/charts';
import { Timeline } from '@/components/data/timeline';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Kpi, KpiGrid, PageHeader } from '@/components/ui/page';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { errorMessage } from '@/lib/api-client';
import { fmtInt, fmtMoney, humanize } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { AnnouncementBanner } from '@/components/marketplace/announcement-banner';
import { CouponOffers } from '@/components/marketplace/coupon-offers';
import { LeadFinderCard } from '@/components/marketplace/lead-finder';
import { WelcomeLeads, type Welcome } from '@/components/onboarding/welcome-leads';
import { GettingStarted } from '@/components/growth/client-growth';

type D = {
  stats: Record<string, number>;
  pipeline: { id: string; name: string; category: string; count: number; value: number }[];
  funnel: { stage: string; value: number }[];
  aging: { bucket: string; count: number }[];
  team: { name: string; comms: number; notes: number; tasksDone: number }[];
  recent: { id: string; type: string; summary: string; verification: 'SYSTEM_VERIFIED' | 'SELF_REPORTED'; createdAt: string; actorName: string; clientLeadId: string | null }[];
};

const leadsLink = (conds: unknown[]) => `/app/leads?filter=${encodeURIComponent(JSON.stringify({ conditions: conds }))}`;

export function ClientDashboard({ name, own, market = false, welcome = null }: { name: string; own: boolean; market?: boolean; welcome?: Welcome | null }) {
  const { data, error } = useApiQuery<D>('/api/v1/crm/dashboard', { refetchInterval: 60_000 });
  if (error) return <ErrorState description={errorMessage(error)} />;
  if (!data) return <Skeleton className="h-96" />;
  const s = data.stats;
  const openValue = data.pipeline.filter((p) => p.category === 'OPEN').reduce((a, p) => a + p.value, 0);
  return (
    <>
      <PageHeader eyebrow={own ? 'My dashboard' : 'Workspace dashboard'} title={`Welcome back, ${name}`} description={own ? 'Leads and tasks assigned to you.' : 'Your team’s pipeline, follow-ups and activity.'} />
      {welcome && <WelcomeLeads w={welcome} />}
      {!own && <GettingStarted />}
      <AnnouncementBanner />
      {market && (
        <div className="mb-4 flex flex-col gap-4 xl:flex-row xl:items-start">
          <div className="min-w-0 flex-[1.3]"><LeadFinderCard /></div>
          <CouponOffers compact className="min-w-0 flex-1" />
        </div>
      )}
      <div className="flex flex-col gap-4">
        <KpiGrid>
          <Kpi label="Active leads" value={fmtInt(s.total)} sub={`${fmtInt(s.new_7d)} new this week`} href="/app/leads" />
          <Kpi label="Uncontacted" value={fmtInt(s.uncontacted)} sub={own ? 'awaiting first contact' : `${fmtInt(s.unassigned)} unassigned`} href={own ? '/app/leads' : '/app/leads?view=unassigned'} />
          <Kpi label="Qualified" value={fmtInt(s.qualified)} sub={`${fmtInt(s.negotiation)} in negotiation`} href={leadsLink([{ field: 'status', op: 'in', value: ['QUALIFIED', 'NEGOTIATION'] }])} />
          <Kpi label="Converted" value={fmtInt(s.converted)} sub={`${fmtInt(s.lost)} lost`} href={leadsLink([{ field: 'status', op: 'in', value: ['CONVERTED'] }])} />
          <Kpi label="Tasks due today" value={fmtInt(s.tasksDue)} sub={`${fmtInt(s.tasksOverdue)} overdue`} href="/app/tasks" />
          <Kpi label="Overdue follow-ups" value={fmtInt(s.overdue_followups)} sub="scheduled follow-up date passed" href={leadsLink([{ field: 'nextFollowUpAt', op: 'before', value: new Date().toISOString().slice(0, 10) }])} />
        </KpiGrid>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader title="Pipeline" description={`${fmtMoney(openValue)} open deal value`} actions={<Link href="/app/pipeline" className="text-xs text-subtle hover:text-fg">Open board →</Link>} />
            <CardBody>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                {data.pipeline.map((p) => (
                  <Link key={p.id} href={leadsLink([{ field: 'stageId', op: 'in', value: [p.id] }])} className="rounded-md border border-border px-3 py-2.5 hover:border-border-strong hover:bg-surface-2">
                    <div className="truncate text-[11px] text-subtle">{p.name}</div>
                    <div className="tnum mt-1 text-lg tracking-tight">{fmtInt(p.count)}</div>
                    <div className="tnum text-[10.5px] text-subtle">{p.value ? fmtMoney(p.value) : '—'}</div>
                  </Link>
                ))}
              </div>
            </CardBody>
          </Card>
          <Card><CardHeader title="Conversion funnel" /><CardBody><Funnel steps={data.funnel} /></CardBody></Card>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Card><CardHeader title="Lead aging" description="Allocated leads with no contact logged" /><CardBody><BarList items={data.aging.map((a) => ({ label: a.bucket, value: a.count }))} /></CardBody></Card>
          {!own && (
            <Card><CardHeader title="Team activity · 7 days" description="Contact attempts, notes and completed tasks (self-reported)" />
              <SimpleTable rows={data.team.map((t, i) => ({ ...t, id: i }))} columns={[
                { key: 'name', header: 'Member' }, { key: 'comms', header: 'Contacts', className: 'tnum text-right' },
                { key: 'notes', header: 'Notes', className: 'tnum text-right' }, { key: 'tasksDone', header: 'Tasks', className: 'tnum text-right' },
              ]} />
            </Card>
          )}
          <Card className={own ? 'xl:col-span-2' : ''}>
            <CardHeader title="Recent events" />
            <CardBody className="max-h-[360px] overflow-y-auto">
              <Timeline items={data.recent.map((r) => ({ id: r.id, title: r.clientLeadId ? <Link className="hover:underline" href={`/app/leads/${r.clientLeadId}`}>{humanize(r.type)} — {r.summary}</Link> : `${humanize(r.type)} — ${r.summary}`, at: r.createdAt, actor: r.actorName, verification: r.verification }))} />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
