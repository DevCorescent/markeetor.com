'use client';
import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BarList, TrendChart } from '@/components/data/charts';
import { DataTable } from '@/components/data/data-table';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Kpi, KpiGrid, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { fmtAgo, fmtInt, humanize } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';

type Overview = {
  failed24h: number; locked: number; denied24h: number; sessions: number; reveals24h: number;
  alerts: { severity: string; status: string; count: number }[];
  privilege: Ev[]; policyChanges: Ev[]; adminAccess: Ev[];
  mfa: { enabled: boolean; platform: boolean; count: number }[];
  topRevealers: { user: { id: string; name: string; email: string } | null; count: number }[];
  failedByIp: { ip: string; count: number }[];
  apiKeys: { id: string; name: string; prefix: string; lastUsedAt: string | null; lastUsedIp: string | null; scopes: string[] }[];
  trend: { day: string; failed: number; succeeded: number; denied: number }[];
};
type Ev = { id: string; action: string; actorEmail: string | null; targetType: string | null; targetId: string | null; createdAt: string; reason: string | null };
type Alert = { id: string; type: string; severity: string; status: string; title: string; createdAt: string; ip: string | null };

export function SecurityCenter() {
  const router = useRouter();
  const { data } = useApiQuery<Overview>('/api/v1/security/overview', { refetchInterval: 30_000 });
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const alerts = useApiQuery<{ total: number; rows: Alert[] }>(`/api/v1/security/alerts?page=${page}&pageSize=15${status ? `&status=${status}` : ''}`);
  const open = data?.alerts.filter((a) => a.status === 'OPEN' || a.status === 'INVESTIGATING').reduce((s, a) => s + a.count, 0) ?? 0;
  const high = data?.alerts.filter((a) => (a.status === 'OPEN' || a.status === 'INVESTIGATING') && (a.severity === 'HIGH' || a.severity === 'CRITICAL')).reduce((s, a) => s + a.count, 0) ?? 0;
  const mfaCov = (platform: boolean) => {
    const rows = data?.mfa.filter((m) => m.platform === platform) ?? [];
    const total = rows.reduce((s, r) => s + r.count, 0);
    const on = rows.filter((r) => r.enabled).reduce((s, r) => s + r.count, 0);
    return total ? `${Math.round((on / total) * 100)}%` : '—';
  };
  const cols: ColumnDef<Alert, unknown>[] = [
    { id: 'sev', header: 'Severity', cell: ({ row: { original: a } }) => <StatusBadge status={a.severity} /> },
    { id: 'title', header: 'Alert', cell: ({ row: { original: a } }) => <div><div className="text-fg">{a.title}</div><div className="text-[11px] text-subtle">{humanize(a.type)}{a.ip ? ` · ${a.ip}` : ''}</div></div> },
    { id: 'status', header: 'Status', cell: ({ row: { original: a } }) => <StatusBadge status={a.status} /> },
    { id: 'at', header: 'Raised', cell: ({ row: { original: a } }) => <span className="text-subtle">{fmtAgo(a.createdAt)}</span> },
  ];
  const evTable = (rows: Ev[]) => <SimpleTable rows={rows} empty={<div className="py-5 text-center text-xs text-subtle">None in the last 7 days</div>} columns={[
    { key: 'action', header: 'Action', render: (r) => <span className="font-mono text-[11px]">{r.action}</span> },
    { key: 'actor', header: 'By', render: (r) => r.actorEmail ?? 'System' },
    { key: 'at', header: 'When', render: (r) => <span className="text-subtle">{fmtAgo(r.createdAt)}</span> },
  ]} />;

  return (
    <>
      <PageHeader title="Security center" description="Authentication health, access anomalies, privilege changes and incident triage." />
      {!data ? <Skeleton className="h-96" /> : (
        <div className="flex flex-col gap-4">
          <KpiGrid>
            <Kpi label="Open alerts" value={fmtInt(open)} sub={`${high} high or critical`} />
            <Kpi label="Failed logins 24h" value={fmtInt(data.failed24h)} sub={`${data.locked} accounts locked`} />
            <Kpi label="Denied requests 24h" value={fmtInt(data.denied24h)} sub="authorization failures" href="/admin/audit?result=DENIED" />
            <Kpi label="Contact reveals 24h" value={fmtInt(data.reveals24h)} sub="audited field reveals" />
            <Kpi label="Active sessions" value={fmtInt(data.sessions)} />
            <Kpi label="MFA coverage" value={mfaCov(true)} sub={`platform · ${mfaCov(false)} clients`} />
          </KpiGrid>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2"><CardHeader title="Authentication — last 14 days" /><CardBody>
              <TrendChart data={data.trend} series={[{ key: 'succeeded', label: 'Successful sign-ins' }, { key: 'failed', label: 'Failed sign-ins' }, { key: 'denied', label: 'Denied requests' }]} />
            </CardBody></Card>
            <Card><CardHeader title="Failed sign-ins by IP (24h)" /><CardBody><BarList items={data.failedByIp.map((f) => ({ label: f.ip, value: f.count }))} empty="No failed sign-ins" /></CardBody></Card>
          </div>
          <DataTable columns={cols} data={alerts.data?.rows ?? []} total={alerts.data?.total ?? 0} page={page} pageSize={15} onPage={setPage} loading={alerts.isFetching} getRowId={(r) => r.id} onRowClick={(r) => router.push(`/admin/security/alerts/${r.id}`)}
            toolbar={<><span className="text-[13px] font-medium">Alerts</span><Select className="ml-auto h-7 w-40" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status"><option value="active">Open & investigating</option><option value="">All</option><option value="RESOLVED">Resolved</option><option value="DISMISSED">Dismissed</option></Select></>} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <Card><CardHeader title="Privilege changes (7d)" />{evTable(data.privilege)}</Card>
            <Card><CardHeader title="Sensitive admin access (7d)" />{evTable(data.adminAccess)}</Card>
            <Card><CardHeader title="Security policy changes (7d)" />{evTable(data.policyChanges)}</Card>
            <Card><CardHeader title="Top contact revealers (24h)" /><CardBody><BarList items={data.topRevealers.map((t) => ({ label: t.user ? `${t.user.name} · ${t.user.email}` : 'Unknown', value: t.count }))} empty="No reveals" /></CardBody></Card>
            <Card className="xl:col-span-2"><CardHeader title="API key activity" actions={<Link href="/admin/settings?tab=api" className="text-xs text-subtle hover:text-fg">Manage →</Link>} />
              <SimpleTable rows={data.apiKeys} empty={<div className="py-5 text-center text-xs text-subtle">No active API keys</div>} columns={[
                { key: 'name', header: 'Key', render: (k) => <span>{k.name} <span className="font-mono text-[11px] text-subtle">lck_{k.prefix}_…</span></span> },
                { key: 'scopes', header: 'Scopes', render: (k) => <span className="flex flex-wrap gap-1">{k.scopes.map((s: string) => <Badge key={s} tone="outline">{s}</Badge>)}</span> },
                { key: 'used', header: 'Last used', render: (k) => <span className="text-subtle">{k.lastUsedAt ? `${fmtAgo(k.lastUsedAt)} · ${k.lastUsedIp ?? ''}` : 'Never'}</span> },
              ]} />
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
