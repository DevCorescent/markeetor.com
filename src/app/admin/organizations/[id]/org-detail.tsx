'use client';
import { OrgTimeline } from '@/components/admin/org-timeline';
import { Archive, Ban, CirclePlay, ImageUp, PauseCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Funnel } from '@/components/data/charts';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, DefinitionList } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Switch, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { Kpi, PageHeader } from '@/components/ui/page';
import { ErrorState, InlineNotice, Skeleton } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { api, errorMessage } from '@/lib/api-client';
import { fmtAgo, fmtDateTime, fmtInt, humanize } from '@/lib/format';
import { useApiMutation, useApiQuery, useUrlState } from '@/lib/hooks';
import { HistoryList } from '../../distribution/batch-list';
import { UsersPanel } from '../../users/users-panel';

type Settings = { features: Record<string, boolean>; security: { mfaRequired: boolean; sessionIdleMinutes: number; ipAllowlist: string[]; revealRequiresReason: boolean; watermark: boolean }; workflows: { staleLeadDays: number; firstContactSlaHours: number }; branding: { primaryLabel?: string } };
type Quota = { maxUsers: number; maxActiveLeads: number; dailyAllocationLimit: number; monthlyAllocationLimit: number; weight: number; acceptsAutoDistribution: boolean; autoPauseAtCapacity: boolean; capacityPaused: boolean; regions: string[]; industries: string[]; campaigns: string[]; minScore: number | null; maxScore: number | null };
type Detail = {
  org: { id: string; code: string; slug: string; name: string; legalName: string | null; gstin?: string | null; billingState?: string | null; industry: string | null; website: string | null; contactEmail: string | null; contactPhone: string | null; address: string | null; timezone: string; status: string; statusReason: string | null; logoKey: string | null; createdAt: string; quota: Quota | null };
  settings: Settings;
  stats: { users: number; activeLeads: number; allocations30d: number; lastAllocatedAt: string | null; byStatus: Record<string, number> };
};

const FEATURE_LABELS: Record<string, string> = { pipeline: 'Sales pipeline', tasks: 'Tasks & follow-ups', communication: 'Communication logs', analytics: 'Analytics', attachments: 'Attachments', teams: 'Team management', email: 'Email & campaigns', automation: 'Workspace automation', marketplace: 'Lead marketplace & billing', funnels: 'Funnels & funnel campaigns' };

export function OrgDetail({ id, perms }: { id: string; perms: { update: boolean; status: boolean; quotas: boolean; invite: boolean; users: boolean; distribution: boolean } }) {
  const { data, error, isLoading } = useApiQuery<Detail>(`/api/v1/organizations/${id}`);
  const [s, set] = useUrlState({ tab: 'overview' });
  const [statusDlg, setStatusDlg] = useState<null | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'ARCHIVED'>(null);
  const status = useApiMutation((b: { status: string; reason: string }) => api(`/api/v1/organizations/${id}/status`, { body: b }), { success: 'Workspace status updated', invalidate: ['/api/v1/organizations'] });
  const logoRef = useRef<HTMLInputElement>(null);
  const [logoV, setLogoV] = useState(0);

  if (error) return <ErrorState description={errorMessage(error)} />;
  if (isLoading || !data) return <Skeleton className="h-96" />;
  const o = data.org;
  const bs = data.stats.byStatus;
  const total = Object.values(bs).reduce((a, b) => a + b, 0);

  const uploadLogo = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    try { await api(`/api/v1/organizations/${id}/logo`, { body: fd }); setLogoV((v) => v + 1); toast.success('Logo updated'); } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Organizations', href: '/admin/organizations' }, { label: o.name }]}
        title={<span className="flex items-center gap-3">
          {o.logoKey && <img src={`/api/v1/organizations/${id}/logo?v=${logoV}`} alt="" className="size-7 rounded border border-border object-cover" />}
          {o.name}<StatusBadge status={o.status} />
        </span>}
        description={<span><span className="font-mono">{o.code}</span> · created {fmtDateTime(o.createdAt)}{o.statusReason && o.status !== 'ACTIVE' ? ` · ${o.statusReason}` : ''}</span>}
        actions={perms.status && (
          <>
            {o.status !== 'ACTIVE' && <Button onClick={() => setStatusDlg('ACTIVE')}><CirclePlay /> {o.status === 'ARCHIVED' ? 'Restore' : 'Activate'}</Button>}
            {o.status === 'ACTIVE' && <Button variant="ghost" onClick={() => setStatusDlg('INACTIVE')}><PauseCircle /> Deactivate</Button>}
            {o.status !== 'SUSPENDED' && o.status !== 'ARCHIVED' && <Button variant="ghost" onClick={() => setStatusDlg('SUSPENDED')}><Ban /> Suspend</Button>}
            {o.status !== 'ARCHIVED' && <Button variant="ghost" onClick={() => setStatusDlg('ARCHIVED')}><Archive /> Archive</Button>}
          </>
        )}
      />
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}>
        <TabsList className="mb-5">
          {['overview', 'timeline', 'profile', 'settings', 'quota', ...(perms.users ? ['users'] : []), ...(perms.distribution ? ['allocations'] : []), 'activity'].map((t) => (
            <TabsTrigger key={t} value={t}>{t === 'quota' ? 'Quotas & allocation' : t === 'settings' ? 'Features & security' : humanize(t)}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {s.tab === 'overview' && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Kpi label="Active leads" value={fmtInt(data.stats.activeLeads)} sub={o.quota ? `of ${fmtInt(o.quota.maxActiveLeads)} max` : undefined} />
            <Kpi label="Allocated (30 days)" value={fmtInt(data.stats.allocations30d)} sub={data.stats.lastAllocatedAt ? `last ${fmtAgo(data.stats.lastAllocatedAt)}` : 'never'} />
            <Kpi label="Users" value={fmtInt(data.stats.users)} sub={o.quota ? `of ${o.quota.maxUsers} seats` : undefined} />
            <Kpi label="Converted" value={fmtInt(bs.CONVERTED ?? 0)} sub={total ? `${(((bs.CONVERTED ?? 0) / total) * 100).toFixed(1)}% of active` : undefined} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card><CardHeader title="Lead status" /><CardBody>
              <Funnel steps={['NEW', 'CONTACTED', 'QUALIFIED', 'NEGOTIATION', 'CONVERTED', 'LOST'].map((k) => ({ stage: humanize(k), value: bs[k] ?? 0 }))} />
            </CardBody></Card>
            <Card><CardHeader title="Configuration summary" /><CardBody>
              <DefinitionList items={[
                ['Features', Object.entries(data.settings.features).filter(([, v]) => v).map(([k]) => FEATURE_LABELS[k]).join(', ')],
                ['MFA required', data.settings.security.mfaRequired ? 'Yes' : 'No'], ['Idle timeout', `${data.settings.security.sessionIdleMinutes} min`],
                ['IP allowlist', data.settings.security.ipAllowlist.length ? data.settings.security.ipAllowlist.join(', ') : 'Not restricted'],
                ['Allocation', o.quota?.capacityPaused ? 'Paused (capacity)' : o.quota?.acceptsAutoDistribution ? 'Manual + automated' : 'Manual only'],
              ]} />
            </CardBody></Card>
          </div>
        </div>
      )}
      {s.tab === 'profile' && <ProfileForm org={o} canEdit={perms.update} onLogo={() => logoRef.current?.click()} />}
      {s.tab === 'settings' && <SettingsForm id={id} settings={data.settings} canEdit={perms.update} />}
      {s.tab === 'quota' && o.quota && <QuotaForm id={id} quota={o.quota} canEdit={perms.quotas} />}
      {s.tab === 'users' && <UsersPanel organizationId={id} canInvite={perms.invite && o.status === 'ACTIVE'} />}
      {s.tab === 'allocations' && <HistoryList organizationId={id} />}
      {s.tab === 'activity' && <OrgActivity id={id} />}
      {s.tab === 'timeline' && <OrgTimeline id={id} />}
      <input ref={logoRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ''; }} />
      <ConfirmDialog open={!!statusDlg} onOpenChange={(v) => !v && setStatusDlg(null)} requireReason danger={statusDlg !== 'ACTIVE'}
        title={`${statusDlg === 'ACTIVE' ? (o.status === 'ARCHIVED' ? 'Restore' : 'Activate') : humanize(statusDlg ?? '')} ${o.name}`}
        typed={statusDlg === 'ARCHIVED' ? o.code : undefined}
        description={statusDlg === 'ACTIVE' ? 'Users regain access immediately.' : 'All workspace users are signed out immediately and cannot sign in until the workspace is reactivated. Leads remain allocated.'}
        confirmLabel="Confirm" onConfirm={(reason) => status.mutateAsync({ status: statusDlg!, reason })} />
    </>
  );
}

function ProfileForm({ org, canEdit, onLogo }: { org: Detail['org']; canEdit: boolean; onLogo: () => void }) {
  const [f, setF] = useState({ name: org.name, legalName: org.legalName ?? '', gstin: org.gstin ?? '', billingState: org.billingState ?? '', industry: org.industry ?? '', website: org.website ?? '', contactEmail: org.contactEmail ?? '', contactPhone: org.contactPhone ?? '', address: org.address ?? '', timezone: org.timezone });
  const save = useApiMutation(() => api(`/api/v1/organizations/${org.id}`, { method: 'PATCH', body: { ...f, legalName: f.legalName || null, gstin: f.gstin || null, billingState: f.billingState || null, industry: f.industry || null, website: f.website || null, contactEmail: f.contactEmail || null, contactPhone: f.contactPhone || null, address: f.address || null } }), { success: 'Profile saved', invalidate: ['/api/v1/organizations'] });
  const inp = (k: keyof typeof f, label: string) => <Field label={label}><Input value={f[k]} disabled={!canEdit} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  return (
    <Card>
      <CardHeader title="Organization profile" actions={canEdit && <Button size="sm" variant="ghost" onClick={onLogo}><ImageUp /> Upload logo</Button>} />
      <CardBody className="grid grid-cols-1 max-w-3xl gap-3 sm:grid-cols-2">
        {inp('name', 'Display name')}{inp('legalName', 'Legal name')}{inp('gstin', 'GSTIN')}{inp('billingState', 'GST state')}{inp('industry', 'Industry')}{inp('website', 'Website')}{inp('contactEmail', 'Contact email')}{inp('contactPhone', 'Contact phone')}{inp('timezone', 'Timezone')}
        <Field label="Address" className="sm:col-span-2"><Textarea value={f.address} disabled={!canEdit} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <Field label="Organization ID"><Input value={org.code} disabled /></Field><Field label="Slug"><Input value={org.slug} disabled /></Field>
        {canEdit && <div className="sm:col-span-2"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save profile</Button></div>}
      </CardBody>
    </Card>
  );
}

function SettingsForm({ id, settings, canEdit }: { id: string; settings: Settings; canEdit: boolean }) {
  const [f, setF] = useState(settings);
  const [ips, setIps] = useState(settings.security.ipAllowlist.join('\n'));
  const save = useApiMutation(() => api(`/api/v1/organizations/${id}/settings`, { method: 'PUT', body: { features: f.features, security: { ...f.security, ipAllowlist: ips.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) }, workflows: f.workflows } }), { success: 'Settings saved', invalidate: ['/api/v1/organizations'] });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Permitted features" description="Disabled features are hidden and blocked server-side for this workspace." />
        <CardBody className="flex flex-col gap-3">
          {Object.entries(FEATURE_LABELS).map(([k, label]) => (
            <label key={k} className="flex items-center justify-between text-[12.5px]">{label}<Switch disabled={!canEdit} checked={f.features[k] ?? false} onCheckedChange={(v) => setF({ ...f, features: { ...f.features, [k]: v } })} aria-label={label} /></label>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Security requirements" description="Workspace admins may tighten these but cannot remove the watermark." />
        <CardBody className="flex flex-col gap-3 text-[12.5px]">
          <label className="flex items-center justify-between">Require two-factor authentication<Switch disabled={!canEdit} checked={f.security.mfaRequired} onCheckedChange={(v) => setF({ ...f, security: { ...f.security, mfaRequired: v } })} /></label>
          <label className="flex items-center justify-between">Require a reason to reveal contact details<Switch disabled={!canEdit} checked={f.security.revealRequiresReason} onCheckedChange={(v) => setF({ ...f, security: { ...f.security, revealRequiresReason: v } })} /></label>
          <label className="flex items-center justify-between">User watermark on sensitive views<Switch disabled={!canEdit} checked={f.security.watermark} onCheckedChange={(v) => setF({ ...f, security: { ...f.security, watermark: v } })} /></label>
          <Field label="Idle session timeout (minutes)"><Input type="number" min={5} max={720} disabled={!canEdit} value={f.security.sessionIdleMinutes} onChange={(e) => setF({ ...f, security: { ...f.security, sessionIdleMinutes: Number(e.target.value) } })} /></Field>
          <Field label="IP allowlist" hint="One IP or prefix (ending in *) per line. Empty = no restriction."><Textarea disabled={!canEdit} value={ips} onChange={(e) => setIps(e.target.value)} className="font-mono text-[12px]" /></Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Workflows" description="Thresholds used by automation and stale-lead monitoring" />
        <CardBody className="grid grid-cols-2 gap-3">
          <Field label="First-contact SLA (hours)"><Input type="number" disabled={!canEdit} value={f.workflows.firstContactSlaHours} onChange={(e) => setF({ ...f, workflows: { ...f.workflows, firstContactSlaHours: Number(e.target.value) } })} /></Field>
          <Field label="Stale after (days)"><Input type="number" disabled={!canEdit} value={f.workflows.staleLeadDays} onChange={(e) => setF({ ...f, workflows: { ...f.workflows, staleLeadDays: Number(e.target.value) } })} /></Field>
        </CardBody>
      </Card>
      {canEdit && <div><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save settings</Button></div>}
    </div>
  );
}

function QuotaForm({ id, quota, canEdit }: { id: string; quota: Quota; canEdit: boolean }) {
  const [f, setF] = useState(quota);
  const [lists, setLists] = useState({ regions: quota.regions.join(', '), industries: quota.industries.join(', '), campaigns: quota.campaigns.join(', ') });
  const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const save = useApiMutation(() => api(`/api/v1/organizations/${id}/quota`, { method: 'PUT', body: {
    maxUsers: f.maxUsers, maxActiveLeads: f.maxActiveLeads, dailyAllocationLimit: f.dailyAllocationLimit, monthlyAllocationLimit: f.monthlyAllocationLimit, weight: f.weight,
    acceptsAutoDistribution: f.acceptsAutoDistribution, autoPauseAtCapacity: f.autoPauseAtCapacity, capacityPaused: f.capacityPaused,
    regions: split(lists.regions), industries: split(lists.industries), campaigns: split(lists.campaigns), minScore: f.minScore, maxScore: f.maxScore,
  } }), { success: 'Quotas saved', invalidate: ['/api/v1/organizations'] });
  const num = (k: keyof Quota, label: string, hint?: string) => <Field label={label} hint={hint}><Input type="number" min={0} disabled={!canEdit} value={(f[k] as number | null) ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value === '' ? null : Number(e.target.value) })} /></Field>;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Quotas" description="Enforced transactionally at allocation time" />
        <CardBody className="grid grid-cols-2 gap-3">
          {num('maxActiveLeads', 'Max active leads')}{num('dailyAllocationLimit', 'Daily allocation limit')}{num('monthlyAllocationLimit', 'Monthly allocation limit')}{num('maxUsers', 'User seats')}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Allocation controls" />
        <CardBody className="flex flex-col gap-3 text-[12.5px]">
          <label className="flex items-center justify-between">Accept automated distribution<Switch disabled={!canEdit} checked={f.acceptsAutoDistribution} onCheckedChange={(v) => setF({ ...f, acceptsAutoDistribution: v })} /></label>
          <label className="flex items-center justify-between">Auto-pause when at capacity<Switch disabled={!canEdit} checked={f.autoPauseAtCapacity} onCheckedChange={(v) => setF({ ...f, autoPauseAtCapacity: v })} /></label>
          <label className="flex items-center justify-between">Allocation paused<Switch disabled={!canEdit} checked={f.capacityPaused} onCheckedChange={(v) => setF({ ...f, capacityPaused: v })} /></label>
          {f.capacityPaused && <InlineNotice tone="warn">This client is excluded from all distributions until resumed.</InlineNotice>}
          {num('weight', 'Weight', 'Relative share for weighted strategies')}
        </CardBody>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader title="Eligibility profile" description="Used by geographic, industry, campaign and score-based strategies" />
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Regions (countries or states)" hint="Comma-separated"><Input disabled={!canEdit} value={lists.regions} onChange={(e) => setLists({ ...lists, regions: e.target.value })} /></Field>
          <Field label="Industries"><Input disabled={!canEdit} value={lists.industries} onChange={(e) => setLists({ ...lists, industries: e.target.value })} /></Field>
          <Field label="Campaigns"><Input disabled={!canEdit} value={lists.campaigns} onChange={(e) => setLists({ ...lists, campaigns: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">{num('minScore', 'Min score')}{num('maxScore', 'Max score')}</div>
        </CardBody>
      </Card>
      {canEdit && <div><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save quotas</Button></div>}
    </div>
  );
}

function OrgActivity({ id }: { id: string }) {
  const [page] = useState(1);
  const { data } = useApiQuery<{ rows: { id: string; action: string; actorEmail: string | null; result: string; targetType: string | null; createdAt: string; reason: string | null }[] }>(`/api/v1/organizations/${id}/activity?page=${page}&pageSize=50`);
  return (
    <Card>
      <CardHeader title="Organization activity" description="Audit events in this workspace and administrative actions taken on it" />
      <SimpleTable rows={data?.rows ?? []} columns={[
        { key: 'action', header: 'Action', render: (r) => <span className="font-mono text-[11.5px]">{r.action}</span> },
        { key: 'actor', header: 'Actor', render: (r) => r.actorEmail ?? 'System' },
        { key: 'result', header: 'Result', render: (r) => <StatusBadge status={r.result} /> },
        { key: 'reason', header: 'Reason', render: (r) => <span className="text-muted">{r.reason ?? '—'}</span> },
        { key: 'createdAt', header: 'When', render: (r) => <span className="text-subtle">{fmtDateTime(r.createdAt)}</span> },
      ]} />
    </Card>
  );
}
