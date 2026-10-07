'use client';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { RolesEditor } from '@/components/data/roles-editor';
import { AutomationSettings } from '@/components/growth/client-growth';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Checkbox, Dialog, Switch, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { Pagination } from '@/components/ui/table-bits';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api-client';
import { fmtDateTime, humanize } from '@/lib/format';
import { useApiMutation, useApiQuery, useUrlState } from '@/lib/hooks';
import { GST_STATES, stateFromGstin } from '@/lib/finance';

type Perms = { settings: boolean; roles: boolean; users: boolean; pipeline: boolean; templates: boolean; audit: boolean };

export function WorkspaceSettings({ perms }: { perms: Perms }) {
  const tabs = [
    ...(perms.settings ? [['general', 'General'], ['automation', 'Automation'], ['security', 'Security'], ['fields', 'Custom fields']] : []),
    ...(perms.pipeline ? [['pipeline', 'Pipeline stages']] : []),
    ...(perms.roles || perms.users ? [['roles', 'Roles']] : []),
    ...(perms.templates ? [['templates', 'Templates']] : []),
    ...(perms.audit ? [['audit', 'Audit trail']] : []),
  ];
  const [s, set] = useUrlState({ tab: tabs[0]?.[0] ?? 'general' });
  return (
    <>
      <PageHeader title="Workspace settings" description="Configure your workspace. Platform-level policies (features, quotas, global security) are managed by the platform administrator." />
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}><TabsList className="mb-5">{tabs.map(([k, l]) => <TabsTrigger key={k} value={k}>{l}</TabsTrigger>)}</TabsList></Tabs>
      {(s.tab === 'general' || s.tab === 'security') && perms.settings && <General tab={s.tab} />}
      {s.tab === 'fields' && perms.settings && <Fields />}
      {s.tab === 'automation' && perms.settings && <AutomationSettings />}
      {s.tab === 'pipeline' && perms.pipeline && <Stages />}
      {s.tab === 'roles' && <RolesEditor endpoint="/api/v1/crm/roles" canManage={perms.roles} scope="ORGANIZATION" />}
      {s.tab === 'templates' && perms.templates && <Templates />}
      {s.tab === 'audit' && perms.audit && <Audit />}
    </>
  );
}

type SettingsResp = { profile: { name: string; code: string; contactEmail: string | null; contactPhone: string | null; address: string | null; timezone: string; hasLogo: boolean; legalName: string | null; gstin: string | null; billingState: string | null }; settings: { security: { mfaRequired: boolean; sessionIdleMinutes: number; ipAllowlist: string[]; revealRequiresReason: boolean; watermark: boolean }; workflows: { staleLeadDays: number; firstContactSlaHours: number }; branding: { primaryLabel?: string } }; platformLocks: { mfaRequired?: boolean } };

function General({ tab }: { tab: string }) {
  const { data } = useApiQuery<SettingsResp>('/api/v1/crm/settings');
  const [p, setP] = useState<SettingsResp['profile'] | null>(null);
  const [sec, setSec] = useState<SettingsResp['settings']['security'] | null>(null);
  const [wf, setWf] = useState<SettingsResp['settings']['workflows'] | null>(null);
  const [ips, setIps] = useState('');
  useEffect(() => { if (data) { setP(data.profile); setSec(data.settings.security); setWf(data.settings.workflows); setIps(data.settings.security.ipAllowlist.join('\n')); } }, [data]);
  const save = useApiMutation((body: object) => api('/api/v1/crm/settings', { method: 'PUT', body }), { success: 'Settings saved', invalidate: ['/api/v1/crm/settings'] });
  if (!data || !p || !sec || !wf) return <Skeleton className="h-64" />;
  if (tab === 'general') return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card><CardHeader title="Workspace profile" description={`${p.name} · ${p.code}`} />
        <CardBody className="grid gap-3">
          <Field label="Contact email"><Input value={p.contactEmail ?? ''} onChange={(e) => setP({ ...p, contactEmail: e.target.value })} /></Field>
          <Field label="Contact phone"><Input value={p.contactPhone ?? ''} onChange={(e) => setP({ ...p, contactPhone: e.target.value })} /></Field>
          <Field label="Timezone"><Input value={p.timezone} onChange={(e) => setP({ ...p, timezone: e.target.value })} /></Field>
          <Field label="Address" hint="Printed on your tax invoices"><Textarea value={p.address ?? ''} onChange={(e) => setP({ ...p, address: e.target.value })} /></Field>
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
            <div className="eyebrow sm:col-span-2">Billing & tax (GST)</div>
            <Field label="Legal business name" className="sm:col-span-2"><Input value={p.legalName ?? ''} onChange={(e) => setP({ ...p, legalName: e.target.value })} placeholder={p.name} /></Field>
            <Field label="GSTIN" hint="Lets you claim input tax credit"><Input value={p.gstin ?? ''} maxLength={15} className="font-mono uppercase" onChange={(e) => { const g = e.target.value.toUpperCase(); setP({ ...p, gstin: g, billingState: stateFromGstin(g) ?? p.billingState }); }} /></Field>
            <Field label="State (place of supply)"><Select value={p.billingState ?? ''} onChange={(e) => setP({ ...p, billingState: e.target.value || null })}><option value="">—</option>{Object.values(GST_STATES).sort().map((x) => <option key={x}>{x}</option>)}</Select></Field>
          </div>
          <div><Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ profile: { contactEmail: p.contactEmail || null, contactPhone: p.contactPhone || null, address: p.address || null, timezone: p.timezone, legalName: p.legalName || null, gstin: p.gstin || null, billingState: p.billingState || null } })}>Save profile</Button></div>
        </CardBody>
      </Card>
      <Card><CardHeader title="Follow-up standards" description="Used by monitoring and automation" />
        <CardBody className="grid gap-3">
          <Field label="First-contact SLA (hours)"><Input type="number" min={1} value={wf.firstContactSlaHours} onChange={(e) => setWf({ ...wf, firstContactSlaHours: Number(e.target.value) })} /></Field>
          <Field label="Treat leads as stale after (days)"><Input type="number" min={1} value={wf.staleLeadDays} onChange={(e) => setWf({ ...wf, staleLeadDays: Number(e.target.value) })} /></Field>
          <div><Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ workflows: wf })}>Save</Button></div>
        </CardBody>
      </Card>
    </div>
  );
  return (
    <Card className="max-w-2xl"><CardHeader title="Security preferences" description="You can tighten these controls. Some are enforced by the platform and cannot be relaxed here." />
      <CardBody className="flex flex-col gap-3 text-[12.5px]">
        <label className="flex items-center justify-between">Require two-factor authentication for all members<Switch checked={sec.mfaRequired} disabled={data.platformLocks.mfaRequired} onCheckedChange={(v) => setSec({ ...sec, mfaRequired: v })} /></label>
        <label className="flex items-center justify-between">Require a reason before revealing contact details<Switch checked={sec.revealRequiresReason} onCheckedChange={(v) => setSec({ ...sec, revealRequiresReason: v })} /></label>
        <label className="flex items-center justify-between text-muted">User watermark on sensitive views (platform controlled)<Switch checked={sec.watermark} disabled onCheckedChange={() => null} /></label>
        <Field label="Idle session timeout (minutes)" hint="Cannot exceed the platform maximum"><Input type="number" min={5} value={sec.sessionIdleMinutes} onChange={(e) => setSec({ ...sec, sessionIdleMinutes: Number(e.target.value) })} className="max-w-[160px]" /></Field>
        <Field label="Restrict sign-in to these IPs" hint="One IP or prefix ending in * per line. Your current IP must be included."><Textarea value={ips} onChange={(e) => setIps(e.target.value)} className="font-mono text-[12px]" /></Field>
        <div><Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ security: { mfaRequired: sec.mfaRequired, revealRequiresReason: sec.revealRequiresReason, sessionIdleMinutes: sec.sessionIdleMinutes, ipAllowlist: ips.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) } })}>Save security preferences</Button></div>
      </CardBody>
    </Card>
  );
}

type Stage = { id?: string; name: string; category: 'OPEN' | 'WON' | 'LOST'; probability: number; stagnantAfterDays: number | null; requiresApproval: boolean };
function Stages() {
  const facets = useApiQuery<{ stages: (Stage & { id: string })[] }>('/api/v1/crm/leads/facets');
  const full = useApiQuery<{ stages: (Stage & { id: string })[] }>('/api/v1/crm/pipeline?perStage=10');
  const [stages, setStages] = useState<Stage[] | null>(null);
  useEffect(() => { if (full.data) setStages(full.data.stages.map(({ id, name, category, probability, stagnantAfterDays, requiresApproval }) => ({ id, name, category, probability, stagnantAfterDays, requiresApproval }))); }, [full.data]);
  const save = useApiMutation(() => api('/api/v1/crm/settings/pipeline', { method: 'PUT', body: { stages } }), { success: 'Pipeline saved', invalidate: ['/api/v1/crm'] });
  if (!stages) return <Skeleton className="h-64" />;
  const upd = (i: number, p: Partial<Stage>) => setStages(stages.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const swap = (i: number, j: number) => { const n = [...stages]; [n[i], n[j]] = [n[j], n[i]]; setStages(n); };
  void facets;
  return (
    <Card><CardHeader title="Pipeline stages" description="Order, win probability, and the age after which a deal is flagged as stagnant. Stages with leads cannot be removed." />
      <CardBody className="flex flex-col gap-2">
        <div className="hidden grid-cols-[28px_1fr_110px_90px_110px_90px_32px] gap-2 px-1 text-[10.5px] sm:grid uppercase tracking-[0.08em] text-subtle"><span /><span>Name</span><span>Type</span><span>Prob. %</span><span>Stagnant (days)</span><span>Approval</span><span /></div>
        {stages.map((s, i) => (
          <div key={s.id ?? `new-${i}`} className="grid grid-cols-[28px_1fr_32px] items-center gap-2 max-sm:rounded-lg max-sm:border max-sm:border-border max-sm:p-2 sm:grid-cols-[28px_1fr_110px_90px_110px_90px_32px]">
            <div className="flex flex-col"><button aria-label="Move up" disabled={i === 0} onClick={() => swap(i, i - 1)} className="text-subtle disabled:opacity-20 hover:text-fg"><ArrowUp className="size-3" /></button><button aria-label="Move down" disabled={i === stages.length - 1} onClick={() => swap(i, i + 1)} className="text-subtle disabled:opacity-20 hover:text-fg"><ArrowDown className="size-3" /></button></div>
            <Input value={s.name} onChange={(e) => upd(i, { name: e.target.value })} aria-label="Stage name" />
            <div className="col-span-3 grid grid-cols-2 gap-2 sm:contents">
              <MLabel text="Type"><Select value={s.category} onChange={(e) => upd(i, { category: e.target.value as Stage['category'] })} aria-label="Type"><option value="OPEN">Open</option><option value="WON">Won</option><option value="LOST">Lost</option></Select></MLabel>
              <MLabel text="Probability %"><Input type="number" min={0} max={100} value={s.probability} onChange={(e) => upd(i, { probability: Number(e.target.value) })} aria-label="Probability" /></MLabel>
              <MLabel text="Stagnant (days)"><Input type="number" min={1} value={s.stagnantAfterDays ?? ''} onChange={(e) => upd(i, { stagnantAfterDays: e.target.value ? Number(e.target.value) : null })} aria-label="Stagnant after days" /></MLabel>
              <MLabel text="Needs approval" row><Checkbox checked={s.requiresApproval} onCheckedChange={(v) => upd(i, { requiresApproval: v })} aria-label="Requires manager approval" /></MLabel>
            </div>
            <Button size="icon" variant="ghost" className="max-sm:col-start-3 max-sm:row-start-1" aria-label="Remove stage" onClick={() => setStages(stages.filter((_, j) => j !== i))}><Trash2 /></Button>
          </div>
        ))}
        <div className="mt-2 flex justify-between">
          <Button size="sm" variant="ghost" onClick={() => setStages([...stages.slice(0, -2), { name: 'New stage', category: 'OPEN', probability: 50, stagnantAfterDays: 14, requiresApproval: false }, ...stages.slice(-2)])}><Plus /> Add stage</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save pipeline</Button>
        </div>
        <p className="text-[11px] text-subtle">“Approval” stages can only be entered by users with pipeline management permission.</p>
      </CardBody>
    </Card>
  );
}

/** Field label shown only on phones, where the editor rows stack (on wider screens the column header labels it). */
function MLabel({ text, row, children }: { text: string; row?: boolean; children: React.ReactNode }) {
  return <label className={cn('flex gap-1 sm:contents', row ? 'items-center gap-2 self-end pb-1.5' : 'flex-col')}><span className="text-[10.5px] tracking-[0.08em] text-subtle uppercase sm:hidden">{text}</span>{children}</label>;
}

type FieldDef = { key: string; label: string; type: string; options: string[]; required: boolean };
function Fields() {
  const facets = useApiQuery<{ fields: FieldDef[] }>('/api/v1/crm/leads/facets');
  const [fields, setFields] = useState<FieldDef[] | null>(null);
  useEffect(() => { if (facets.data) setFields(facets.data.fields.map(({ key, label, type, options, required }) => ({ key, label, type, options, required }))); }, [facets.data]);
  const save = useApiMutation(() => api('/api/v1/crm/settings/fields', { method: 'PUT', body: { fields } }), { success: 'Custom fields saved', invalidate: ['/api/v1/crm'] });
  if (!fields) return <Skeleton className="h-48" />;
  const upd = (i: number, p: Partial<FieldDef>) => setFields(fields.map((f, j) => (j === i ? { ...f, ...p } : f)));
  return (
    <Card><CardHeader title="Custom lead fields" description="Extra fields your team can fill on each lead. Removing a field hides its values." />
      <CardBody className="flex flex-col gap-2">
        {fields.length === 0 && <p className="text-xs text-subtle">No custom fields yet.</p>}
        {fields.map((f, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_32px] items-center gap-2 max-sm:rounded-lg max-sm:border max-sm:border-border max-sm:p-2 sm:grid-cols-[1fr_1fr_120px_1.4fr_70px_32px]">
            <Input value={f.label} onChange={(e) => upd(i, { label: e.target.value, key: f.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) })} placeholder="Label" aria-label="Label" />
            <Input value={f.key} onChange={(e) => upd(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} placeholder="key" className="font-mono text-[12px]" aria-label="Key" />
            <div className="col-span-3 grid grid-cols-[1fr_auto] items-center gap-2 sm:contents">
              <Select value={f.type} onChange={(e) => upd(i, { type: e.target.value })} aria-label="Type">{['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN'].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select>
              <Input value={f.options.join(', ')} disabled={f.type !== 'SELECT'} className="max-sm:order-last max-sm:col-span-2" onChange={(e) => upd(i, { options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder={f.type === 'SELECT' ? 'Option A, Option B' : '—'} aria-label="Options" />
              <label className="flex items-center gap-1.5 text-[11.5px]"><Checkbox checked={f.required} onCheckedChange={(v) => upd(i, { required: v })} aria-label="Required" />Req.</label>
            </div>
            <Button size="icon" variant="ghost" className="max-sm:col-start-3 max-sm:row-start-1" aria-label="Remove field" onClick={() => setFields(fields.filter((_, j) => j !== i))}><X /></Button>
          </div>
        ))}
        <div className="mt-2 flex justify-between">
          <Button size="sm" variant="ghost" onClick={() => setFields([...fields, { key: '', label: '', type: 'TEXT', options: [], required: false }])}><Plus /> Add field</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save fields</Button>
        </div>
      </CardBody>
    </Card>
  );
}

type Tpl = { id: string; name: string; channel: string; subject: string | null; body: string };
function Templates() {
  const { data } = useApiQuery<{ templates: Tpl[] }>('/api/v1/crm/templates');
  const [edit, setEdit] = useState<Tpl | 'new' | null>(null);
  const del = useApiMutation((id: string) => api(`/api/v1/crm/templates/${id}`, { method: 'DELETE' }), { success: 'Template deleted', invalidate: ['/api/v1/crm/templates'] });
  return (
    <>
      <InlineNotice className="mb-3">Templates help your team log consistent messages. Sending email, SMS or WhatsApp directly requires a provider integration configured by the platform; until then, use templates as reference text.</InlineNotice>
      <Card><CardHeader title="Communication templates" actions={<Button size="sm" variant="primary" onClick={() => setEdit('new')}><Plus /> New template</Button>} />
        <SimpleTable rows={data?.templates ?? []} empty={<div className="py-6 text-center text-xs text-subtle">No templates</div>} onRowClick={setEdit} columns={[
          { key: 'name', header: 'Name' }, { key: 'channel', header: 'Channel', render: (t) => humanize(t.channel) }, { key: 'subject', header: 'Subject', render: (t) => t.subject ?? '—' },
          { key: 'x', header: '', render: (t) => <Button size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); del.mutate(t.id); }}><Trash2 /></Button> },
        ]} />
      </Card>
      {edit && <TemplateForm tpl={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function TemplateForm({ tpl, onClose }: { tpl: Tpl | null; onClose: () => void }) {
  const [f, setF] = useState({ name: tpl?.name ?? '', channel: tpl?.channel ?? 'EMAIL', subject: tpl?.subject ?? '', body: tpl?.body ?? '' });
  const save = useApiMutation(() => api(tpl ? `/api/v1/crm/templates/${tpl.id}` : '/api/v1/crm/templates', { method: tpl ? 'PUT' : 'POST', body: { ...f, subject: f.subject || null } }), { success: 'Template saved', invalidate: ['/api/v1/crm/templates'], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={tpl ? 'Edit template' : 'New template'} size="md" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={f.name.length < 2 || !f.body.trim()} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3"><Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Channel"><Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{['EMAIL', 'SMS', 'WHATSAPP', 'CALL', 'MEETING'].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select></Field></div>
        <Field label="Subject"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
        <Field label="Body"><Textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} className="min-h-[160px]" /></Field>
      </div>
    </Dialog>
  );
}

function Audit() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const { data } = useApiQuery<{ total: number; rows: { id: string; action: string; actorEmail: string | null; targetType: string | null; result: string; reason: string | null; createdAt: string; ip: string | null }[] }>(`/api/v1/crm/audit?page=${page}&pageSize=50${action ? `&action=${encodeURIComponent(action)}` : ''}`);
  return (
    <Card><CardHeader title="Workspace audit trail" description="Actions taken in your workspace, including denied attempts." actions={<Input className="h-7 w-48" placeholder="Filter by action prefix" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} />} />
      <SimpleTable rows={data?.rows ?? []} columns={[
        { key: 'createdAt', header: 'When', render: (r) => <span className="text-subtle">{fmtDateTime(r.createdAt)}</span> },
        { key: 'action', header: 'Action', render: (r) => <span className="font-mono text-[11.5px]">{r.action}</span> },
        { key: 'actor', header: 'Actor', render: (r) => r.actorEmail ?? 'System' },
        { key: 'target', header: 'Target', render: (r) => humanize(r.targetType) },
        { key: 'result', header: 'Result', render: (r) => <StatusBadge status={r.result} /> },
        { key: 'ip', header: 'IP', render: (r) => <span className="font-mono text-[11px] text-subtle">{r.ip ?? '—'}</span> },
      ]} />
      <Pagination page={page} pageSize={50} total={data?.total ?? 0} onPage={setPage} />
    </Card>
  );
}
