'use client';
import { CircleCheck, CircleX, Copy, KeyRound, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select } from '@/components/ui/input';
import { Checkbox, Dialog, Drawer, Switch, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { api } from '@/lib/api-client';
import { fmtAgo, fmtDateTime } from '@/lib/format';
import { useApiMutation, useApiQuery, useUrlState } from '@/lib/hooks';
import { AppearanceSettings, BrandingSettings, SeoSettings } from './branding-settings';

type S = Record<string, Record<string, unknown>>;
const LABELS: Record<string, Record<string, string>> = {
  'security.policy': {
    passwordMinLength: 'Minimum password length', lockoutThreshold: 'Failed attempts before lockout', lockoutMinutes: 'Lockout duration (minutes)',
    sessionAbsoluteHours: 'Session lifetime (hours)', sessionIdleMinutes: 'Idle timeout (minutes)', mfaRequiredForPlatform: 'Require MFA for platform staff',
    stepUpMinutes: 'Step-up validity (minutes)', revealsPerHour: 'Contact reveals per user per hour', leadViewsPerHourAlert: 'Alert above lead views per user per hour',
    forbiddenBurstThreshold: 'Alert after denied requests in 10 min', apiRequestsPerMinute: 'API requests per user per minute',
  },
  'distribution.policy': { largeBatchThreshold: 'Typed confirmation above (leads)', rollbackWindowHours: 'Rollback window (hours)', maxBatchSize: 'Maximum batch size' },
  'imports.policy': { fileRetentionDays: 'Delete uploaded files after (days)', rowDataRetentionDays: 'Purge raw row data after (days)', maxRows: 'Maximum rows per file', defaultCountry: 'Default phone country (ISO)' },
  'audit.retention': { days: 'Retain audit events for (days)' },
  'ai.config': { enabled: 'Enable AI features', provider: 'Provider identifier', allowLeadDataEgress: 'Allow lead data to be sent to the provider' },
};

export function PlatformSettings({ perms, isProd }: { perms: { system: boolean; security: boolean; audit: boolean }; isProd: boolean }) {
  const [s, set] = useUrlState({ tab: perms.system ? 'branding' : perms.security ? 'security' : 'audit' });
  const { data } = useApiQuery<{ settings: S }>('/api/v1/settings');
  const tabs = [
    ...(perms.system ? [['branding', 'Branding'], ['seo', 'SEO & indexing'], ['appearance', 'Appearance']] : []),
    ...(perms.security || perms.system ? [['security', 'Security policy']] : []),
    ...(perms.system ? [['operations', 'Imports & distribution']] : []),
    ...(perms.audit ? [['audit', 'Audit retention']] : []),
    ...(perms.system ? [['ai', 'AI features'], ['integrations', 'Integrations'], ['api', 'API keys'], ['outbox', 'Outbox'], ['reference', 'API reference']] : []),
  ];
  return (
    <>
      <PageHeader title="Platform settings" description="Brand, search presence, appearance and global policies for every workspace. Changes require re-verification and are audited with before/after values." />
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}><TabsList className="mb-5">{tabs.map(([k, l]) => <TabsTrigger key={k} value={k}>{l}</TabsTrigger>)}</TabsList></Tabs>
      {!data ? <Skeleton className="h-64" /> : (
        <>
          {s.tab === 'branding' && <BrandingSettings value={data.settings.branding as never} />}
          {s.tab === 'seo' && <SeoSettings value={data.settings.seo as never} productName={String((data.settings.branding as { productName?: string })?.productName ?? '')} />}
          {s.tab === 'appearance' && <AppearanceSettings value={data.settings.appearance as never} />}
          {s.tab === 'security' && <PolicyForm k="security.policy" value={data.settings['security.policy']} />}
          {s.tab === 'operations' && <div className="grid grid-cols-1 gap-4 lg:grid-cols-2"><PolicyForm k="imports.policy" value={data.settings['imports.policy']} /><PolicyForm k="distribution.policy" value={data.settings['distribution.policy']} /></div>}
          {s.tab === 'audit' && <PolicyForm k="audit.retention" value={data.settings['audit.retention']} note="Events older than this are purged daily by the worker. The purge itself is recorded in the audit log. Minimum 90 days." />}
          {s.tab === 'ai' && <PolicyForm k="ai.config" value={data.settings['ai.config']} note="AI features are off by default. Enabling them requires AI_PROVIDER_API_KEY on the server. Lead data is never sent to an external provider unless data egress is explicitly allowed here. Outputs are advisory and require human review for allocation decisions." />}
        </>
      )}
      {s.tab === 'integrations' && <Integrations />}
      {s.tab === 'api' && <ApiKeys />}
      {s.tab === 'outbox' && <Outbox isProd={isProd} />}
      {s.tab === 'reference' && <ApiReference />}
    </>
  );
}

function PolicyForm({ k, value, note }: { k: string; value: Record<string, unknown>; note?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const save = useApiMutation(() => api('/api/v1/settings', { method: 'PUT', body: { key: k, value: v } }), { success: 'Settings saved', invalidate: ['/api/v1/settings'] });
  return (
    <Card>
      <CardHeader title={k === 'security.policy' ? 'Authentication & access' : k === 'imports.policy' ? 'Imports' : k === 'distribution.policy' ? 'Distribution' : k === 'audit.retention' ? 'Retention' : 'AI'} />
      <CardBody className="flex max-w-2xl flex-col gap-3">
        {note && <InlineNotice>{note}</InlineNotice>}
        {Object.entries(v).map(([key, val]) => (
          typeof val === 'boolean' ? (
            <label key={key} className="flex items-center justify-between text-[12.5px]">{LABELS[k]?.[key] ?? key}<Switch checked={val} onCheckedChange={(c) => setV({ ...v, [key]: c })} /></label>
          ) : (
            <Field key={key} label={LABELS[k]?.[key] ?? key}><Input type={typeof val === 'number' ? 'number' : 'text'} value={val == null ? '' : String(val)} onChange={(e) => setV({ ...v, [key]: typeof val === 'number' ? Number(e.target.value) : e.target.value || null })} className="max-w-[240px]" /></Field>
          )
        ))}
        <div><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></div>
      </CardBody>
    </Card>
  );
}

type Integ = { provider: string; label: string; description: string; env: string[]; configured: boolean; missing: string[]; enabled: boolean };
function Integrations() {
  const { data } = useApiQuery<{ integrations: Integ[] }>('/api/v1/settings/integrations');
  const toggle = useApiMutation((b: { provider: string; enabled: boolean }) => api('/api/v1/settings/integrations', { method: 'PUT', body: b }), { success: 'Integration updated', invalidate: ['/api/v1/settings/integrations'] });
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {data?.integrations.map((i) => (
        <Card key={i.provider}>
          <CardBody className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[13px] font-medium">{i.configured ? <CircleCheck className="size-4 text-ok" /> : <CircleX className="size-4 text-subtle" />}{i.label}</span>
              <Switch checked={i.enabled} disabled={!i.configured} onCheckedChange={(v) => toggle.mutate({ provider: i.provider, enabled: v })} aria-label={`Enable ${i.label}`} />
            </div>
            <p className="text-xs text-subtle">{i.description}</p>
            <p className="text-[11px] text-muted">{i.configured ? 'Credentials present in server environment.' : <>Not configured — set <span className="font-mono">{i.missing.join(', ')}</span> in the server environment. Secrets are never stored in the database.</>}</p>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

type Key = { id: string; name: string; prefix: string; scopes: string[]; lastUsedAt: string | null; lastUsedIp: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string };
function ApiKeys() {
  const { data } = useApiQuery<{ keys: Key[] }>('/api/v1/settings/api-keys');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', scopes: ['leads.read'] as string[], expiresInDays: '90' });
  const [created, setCreated] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<Key | null>(null);
  const create = useApiMutation(() => api<{ key: string }>('/api/v1/settings/api-keys', { body: { name: f.name, scopes: f.scopes, expiresInDays: f.expiresInDays ? Number(f.expiresInDays) : null } }), { invalidate: ['/api/v1/settings/api-keys'], onSuccess: (r) => { setCreated(r.key); setOpen(false); } });
  const rev = useApiMutation((id: string) => api(`/api/v1/settings/api-keys/${id}`, { method: 'DELETE' }), { success: 'Key revoked', invalidate: ['/api/v1/settings/api-keys'] });
  return (
    <>
      <Card>
        <CardHeader title="API keys" description="Read-only keys for platform integrations. A key acts as its creator, narrowed to its scopes; if the creator loses access, so does the key." actions={<Button size="sm" variant="primary" onClick={() => setOpen(true)}><Plus /> New key</Button>} />
        <SimpleTable rows={data?.keys ?? []} empty={<div className="py-6 text-center text-xs text-subtle">No API keys</div>} columns={[
          { key: 'name', header: 'Name', render: (k) => <span>{k.name} <span className="font-mono text-[11px] text-subtle">lck_{k.prefix}_…</span></span> },
          { key: 'scopes', header: 'Scopes', render: (k) => <span className="flex flex-wrap gap-1">{k.scopes.map((s: string) => <Badge key={s} tone="outline">{s}</Badge>)}</span> },
          { key: 'status', header: 'Status', render: (k) => <StatusBadge status={k.revokedAt ? 'REVOKED' : k.expiresAt && new Date(k.expiresAt) < new Date() ? 'EXPIRED' : 'ACTIVE'} /> },
          { key: 'used', header: 'Last used', render: (k) => <span className="text-subtle">{k.lastUsedAt ? `${fmtAgo(k.lastUsedAt)} · ${k.lastUsedIp}` : 'Never'}</span> },
          { key: 'expires', header: 'Expires', render: (k) => <span className="text-subtle">{k.expiresAt ? fmtDateTime(k.expiresAt) : 'Never'}</span> },
          { key: 'x', header: '', render: (k) => !k.revokedAt && <Button size="xs" variant="ghost" onClick={() => setRevoke(k)}><X /> Revoke</Button> },
        ]} />
      </Card>
      <Dialog open={open} onOpenChange={setOpen} title="New API key" size="sm" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={f.name.length < 2 || !f.scopes.length} onClick={() => create.mutate(undefined)}><KeyRound /> Create</Button></>}>
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="BI warehouse sync" /></Field>
          <Field label="Scopes (read-only)">
            <div className="flex flex-col gap-1.5 text-[12.5px]">{['leads.read', 'imports.read', 'distribution.read', 'analytics.read', 'orgs.read'].map((sc) => <label key={sc} className="flex items-center gap-2"><Checkbox checked={f.scopes.includes(sc)} onCheckedChange={(c) => setF({ ...f, scopes: c ? [...f.scopes, sc] : f.scopes.filter((x) => x !== sc) })} aria-label={sc} /><span className="font-mono text-[11.5px]">{sc}</span></label>)}</div>
          </Field>
          <Field label="Expires after"><Select value={f.expiresInDays} onChange={(e) => setF({ ...f, expiresInDays: e.target.value })}><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="">Never</option></Select></Field>
        </div>
      </Dialog>
      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)} title="Copy your API key" size="md" footer={<Button variant="primary" onClick={() => setCreated(null)}>Done</Button>}>
        <InlineNotice tone="warn" className="mb-3">This is the only time the key is shown. Store it in a secrets manager.</InlineNotice>
        <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded border border-border-strong bg-surface-2 px-2 py-1.5 font-mono text-[11px]">{created}</code><Button size="sm" onClick={() => { navigator.clipboard.writeText(created!); toast.success('Copied'); }}><Copy /></Button></div>
      </Dialog>
      <ConfirmDialog open={!!revoke} onOpenChange={(o) => !o && setRevoke(null)} title={`Revoke “${revoke?.name}”`} danger confirmLabel="Revoke" description="Integrations using this key stop working immediately." onConfirm={() => rev.mutateAsync(revoke!.id)} />
    </>
  );
}

type Mail = { id: string; to: string; subject: string; body?: string; status: string; createdAt: string; error: string | null };
function Outbox({ isProd }: { isProd: boolean }) {
  const { data } = useApiQuery<{ rows: Mail[]; showBodies: boolean }>('/api/v1/settings/outbox?pageSize=50');
  const [open, setOpen] = useState<Mail | null>(null);
  return (
    <>
      <InlineNotice className="mb-3">{isProd ? 'Delivery log. Message bodies are hidden in production because they contain single-use links.' : 'Development outbox: without SMTP configured, emails (invitations, password resets, reports) are stored here instead of being sent.'}</InlineNotice>
      <Card><SimpleTable rows={data?.rows ?? []} onRowClick={data?.showBodies ? setOpen : undefined} columns={[
        { key: 'to', header: 'To' }, { key: 'subject', header: 'Subject' },
        { key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
        { key: 'createdAt', header: 'Created', render: (m) => <span className="text-subtle">{fmtAgo(m.createdAt)}</span> },
      ]} /></Card>
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open?.subject} description={`To ${open?.to}`}>
        <pre className="font-sans text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg-2">{open?.body}</pre>
      </Drawer>
    </>
  );
}

type Spec = { paths: Record<string, Record<string, { description: string; 'x-permissions': string[]; requestBody?: unknown }>> };
function ApiReference() {
  const { data, error } = useApiQuery<Spec>('/api/v1/openapi.json');
  const [q, setQ] = useState('');
  if (error) return <InlineNotice tone="warn">The OpenAPI document has not been generated. Run <span className="font-mono">npm run openapi</span>.</InlineNotice>;
  if (!data) return <Skeleton className="h-64" />;
  const rows = Object.entries(data.paths).flatMap(([p, ms]) => Object.entries(ms).map(([m, op]) => ({ id: `${m} ${p}`, method: m.toUpperCase(), path: p, ...op }))).filter((r) => !q || r.path.includes(q));
  return (
    <Card>
      <CardHeader title="REST API v1" description="Generated from the route handlers’ declared permissions and validation schemas." actions={<a href="/api/v1/openapi.json" target="_blank" className="text-xs text-subtle hover:text-fg">openapi.json ↗</a>} />
      <div className="border-b border-border px-4 py-2"><Input placeholder="Filter paths…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" /></div>
      <SimpleTable rows={rows} columns={[
        { key: 'method', header: 'Method', render: (r) => <span className="font-mono text-[11px] text-fg">{r.method}</span> },
        { key: 'path', header: 'Path', render: (r) => <span className="font-mono text-[11.5px]">{r.path}</span> },
        { key: 'description', header: 'Access', render: (r) => <span className="block max-w-[520px] whitespace-normal text-[11.5px] text-muted">{r.description}</span> },
      ]} />
    </Card>
  );
}
