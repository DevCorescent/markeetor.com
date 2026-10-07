'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { CheckCircle2, CircleAlert, Clock, MailPlus, Pencil, Plus, Search, Send, ShieldCheck, Star, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/data/data-table';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select } from '@/components/ui/input';
import { Drawer, Switch, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { Kpi, PageHeader } from '@/components/ui/page';
import { EmptyState, InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { renderEmail } from '@/lib/email/render';
import { PRESETS } from '@/lib/email/presets';
import { SAMPLE_VARIABLES, type EmailDesign } from '@/lib/email/types';
import { fmtAgo, fmtDateTime, fmtInt, fmtPct } from '@/lib/format';
import { useApiMutation, useApiQuery, useUrlState } from '@/lib/hooks';
import { EndpointsList } from './endpoints-list';
import { MailHistory } from './mail-history';
import { deliverabilityTone, SenderDeliverability } from './sender-deliverability';
import { WelcomeEmails } from './welcome-emails';

type Campaign = { id: string; name: string; subject: string; status: string; totalRecipients: number; sentCount: number; failedCount: number; skippedCount: number; openedCount: number; trackOpens: boolean; scheduledFor: string | null; createdAt: string; completedAt: string | null; createdBy: string; sender: { label: string; fromEmail: string } | null };
type Msg = { id: string; toEmail: string; toName: string | null; subject: string; status: string; error: string | null; sentAt: string | null; openedAt: string | null; openCount: number; createdAt: string; campaign: { id: string; name: string } | null };
type Tpl = { id: string; name: string; category: string | null; subject: string; preheader: string | null; updatedAt: string; design: EmailDesign };
export type SenderRow = { id: string; label: string; host: string; port: number; secure: boolean; username: string; fromName: string; fromEmail: string; replyTo: string | null; dailyLimit: number; perMinuteLimit: number; isDefault: boolean; status: string; lastVerifiedAt: string | null; lastError: string | null; sentLast24h: number; dkimEnabled?: boolean; deliverability?: { score: number } | null };

export function EmailHub({ base, canManage, canSend, workspace, canWelcome = false }: { base: '/admin' | '/app'; canManage: boolean; canSend: boolean; workspace: boolean; canWelcome?: boolean }) {
  const router = useRouter();
  const [s, set] = useUrlState({ tab: 'overview' });
  return (
    <>
      <PageHeader
        title="Email"
        description={workspace ? 'Send personalised emails and campaigns to your leads from your own SMTP senders. Every message is logged; unsubscribes are honoured automatically.' : 'Platform email: SMTP senders, campaigns to master leads, templates and the delivery log.'}
        actions={
          <>
            {canManage && <Button onClick={() => router.push(`${base}/email/templates/new`)}><Plus /> New template</Button>}
            {canSend && <Button variant="primary" onClick={() => router.push(`${base}/${workspace ? 'leads' : 'leads'}?emailHint=1`)}><MailPlus /> New campaign</Button>}
          </>
        }
      />
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}>
        <TabsList className="mb-5">
          <TabsTrigger value="overview">Campaigns</TabsTrigger>
          {!workspace && canManage && <TabsTrigger value="endpoints">Endpoints</TabsTrigger>}
          {workspace ? <TabsTrigger value="log">Delivery log</TabsTrigger> : <TabsTrigger value="history">History</TabsTrigger>}
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="senders">Senders</TabsTrigger>
          {canWelcome && <TabsTrigger value="welcome">Welcome emails</TabsTrigger>}
        </TabsList>
      </Tabs>
      {s.tab === 'overview' && <Overview base={base} />}
      {s.tab === 'log' && <MessageLog />}
      {s.tab === 'history' && !workspace && <MailHistory base={base} canManage={canManage} />}
      {s.tab === 'endpoints' && !workspace && canManage && <EndpointsList base={base} />}
      {s.tab === 'templates' && <Templates base={base} canManage={canManage} canSend={canSend} />}
      {s.tab === 'senders' && <Senders canManage={canManage} />}
      {s.tab === 'welcome' && canWelcome && <WelcomeEmails base={base} />}
    </>
  );
}

function Overview({ base }: { base: string }) {
  const router = useRouter();
  const stats = useApiQuery<{ sent: number; failed: number; skipped: number; queued: number; opened: number; openRate: number | null }>('/api/v1/email/stats', { refetchInterval: 15_000 });
  const [page, setPage] = useState(1);
  const { data, isFetching } = useApiQuery<{ total: number; rows: Campaign[] }>(`/api/v1/email/campaigns?page=${page}&pageSize=20`, { refetchInterval: 8000 });
  const columns: ColumnDef<Campaign, unknown>[] = [
    { id: 'name', header: 'Campaign', cell: ({ row: { original: c } }) => <div className="min-w-[200px]"><div className="truncate text-fg">{c.name}</div><div className="truncate text-[11px] text-subtle">{c.subject}</div></div> },
    { id: 'status', header: 'Status', cell: ({ row: { original: c } }) => <StatusBadge status={c.status} /> },
    { id: 'progress', header: 'Delivered', cell: ({ row: { original: c } }) => { const sendable = c.totalRecipients - c.skippedCount; return <div className="w-36"><div className="tnum text-[11.5px]">{fmtInt(c.sentCount)} / {fmtInt(sendable)}</div><div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-fg/80" style={{ width: `${sendable ? (c.sentCount / sendable) * 100 : 0}%` }} /></div></div>; } },
    { id: 'opens', header: 'Opens', cell: ({ row: { original: c } }) => <span className="tnum">{c.trackOpens ? fmtPct(c.sentCount ? c.openedCount / c.sentCount : null, 0) : <span className="text-subtle">off</span>}</span> },
    { id: 'failed', header: 'Failed / skipped', cell: ({ row: { original: c } }) => <span className="tnum text-muted"><span className={c.failedCount ? 'text-danger' : ''}>{c.failedCount}</span> / {c.skippedCount}</span> },
    { id: 'sender', header: 'Sender', cell: ({ row: { original: c } }) => <span className="text-muted">{c.sender?.fromEmail ?? '—'}</span> },
    { id: 'when', header: 'Created', cell: ({ row: { original: c } }) => <span className="text-subtle">{c.status === 'SCHEDULED' && c.scheduledFor ? `sends ${fmtDateTime(c.scheduledFor)}` : `${c.createdBy} · ${fmtAgo(c.createdAt)}`}</span> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
        <Kpi label="Sent · 30 days" value={fmtInt(stats.data?.sent ?? 0)} />
        <Kpi label="Open rate" value={fmtPct(stats.data?.openRate ?? null, 1)} sub="approximate — image blockers" />
        <Kpi label="In queue" value={fmtInt(stats.data?.queued ?? 0)} />
        <Kpi label="Failed" value={fmtInt(stats.data?.failed ?? 0)} />
        <Kpi label="Skipped" value={fmtInt(stats.data?.skipped ?? 0)} sub="no address, unsubscribed, opted out" />
      </div>
      <DataTable columns={columns} data={data?.rows ?? []} total={data?.total ?? 0} page={page} pageSize={20} onPage={setPage} loading={isFetching} getRowId={(r) => r.id}
        onRowClick={(r) => router.push(`${base}/email/campaigns/${r.id}`)}
        empty={<EmptyState icon={Send} title="No campaigns yet" description="Select leads in the leads list and choose “Email”, or start from a template." action={<Link href={`${base}/leads`}><Button variant="primary" size="sm">Go to leads</Button></Link>} />} />
    </div>
  );
}

export function MessageLog({ campaignId }: { campaignId?: string }) {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const { data, isFetching } = useApiQuery<{ total: number; rows: Msg[] }>(`/api/v1/email/messages?page=${page}&pageSize=50${campaignId ? `&campaignId=${campaignId}` : ''}${status ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`, { refetchInterval: 8000 });
  const columns: ColumnDef<Msg, unknown>[] = [
    { id: 'to', header: 'Recipient', cell: ({ row: { original: m } }) => <div><div className="text-fg">{m.toName ?? '—'}</div><div className="font-mono text-[11px] text-subtle">{m.toEmail}</div></div> },
    { id: 'subject', header: 'Subject', cell: ({ row: { original: m } }) => <div className="max-w-[280px] truncate">{m.subject}{!campaignId && m.campaign && <div className="truncate text-[11px] text-subtle">{m.campaign.name}</div>}</div> },
    { id: 'status', header: 'Status', cell: ({ row: { original: m } }) => <span className="flex items-center gap-1.5"><StatusBadge status={m.status} />{m.openedAt && <Badge tone="ok">Opened{m.openCount > 1 ? ` ×${m.openCount}` : ''}</Badge>}</span> },
    { id: 'detail', header: 'Detail', cell: ({ row: { original: m } }) => <span className="block max-w-[300px] truncate text-[11.5px] text-muted" title={m.error ?? ''}>{m.error ?? (m.sentAt ? `Sent ${fmtDateTime(m.sentAt)}` : '—')}</span> },
    { id: 'at', header: 'Queued', cell: ({ row: { original: m } }) => <span className="text-subtle">{fmtAgo(m.createdAt)}</span> },
  ];
  return (
    <DataTable columns={columns} data={data?.rows ?? []} total={data?.total ?? 0} page={page} pageSize={50} onPage={setPage} loading={isFetching} getRowId={(r) => r.id} dense
      empty={<EmptyState title="No messages" description="Messages appear here as soon as a campaign is queued." />}
      toolbar={
        <>
          <div className="relative w-56"><Search className="absolute top-2 left-2.5 size-3.5 text-subtle" /><Input className="h-7 pl-8" placeholder="Search name or subject" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
          <div className="flex items-center rounded-md border border-border bg-surface p-0.5">
            {['', 'QUEUED', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED'].map((st) => <button key={st} onClick={() => { setStatus(st); setPage(1); }} className={`h-6 rounded px-2 text-[11.5px] ${status === st ? 'bg-fg text-inverse' : 'text-muted hover:text-fg'}`}>{st ? st[0] + st.slice(1).toLowerCase() : 'All'}</button>)}
          </div>
        </>
      } />
  );
}

export function EmailThumb({ design, preheader, height = 220 }: { design: EmailDesign; preheader?: string | null; height?: number }) {
  const html = useMemo(() => renderEmail(design, { preheader, vars: SAMPLE_VARIABLES }).html, [design, preheader]);
  return (
    <div className="relative overflow-hidden rounded-t-lg bg-white" style={{ height }}>
      <iframe title="Template thumbnail" sandbox="" srcDoc={html} tabIndex={-1} className="pointer-events-none absolute top-0 left-0 origin-top-left" style={{ width: 720, height: height / 0.42, transform: 'scale(0.42)' }} />
    </div>
  );
}

function Templates({ base, canManage, canSend }: { base: string; canManage: boolean; canSend: boolean }) {
  const router = useRouter();
  const { data, isLoading } = useApiQuery<{ templates: Tpl[] }>('/api/v1/email/templates');
  const [del, setDel] = useState<Tpl | null>(null);
  const remove = useApiMutation((id: string) => api(`/api/v1/email/templates/${id}`, { method: 'DELETE' }), { success: 'Template archived', invalidate: ['/api/v1/email/templates'] });
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mb-2.5 flex items-end justify-between"><h2 className="text-[13.5px] font-medium">Your templates</h2></div>
        {isLoading ? <Skeleton className="h-64" /> : !data?.templates.length ? (
          <Card><EmptyState title="No saved templates" description={canManage ? 'Start from one of the designs below.' : 'Ask an administrator to create templates.'} /></Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {data.templates.map((t) => (
              <Card key={t.id} className="group overflow-hidden">
                <button className="block w-full text-left" onClick={() => router.push(`${base}/email/templates/${t.id}`)}><EmailThumb design={t.design} preheader={t.preheader} /></button>
                <div className="flex items-start justify-between gap-2 border-t border-border px-3 py-2.5">
                  <div className="min-w-0"><div className="truncate text-[12.5px] text-fg">{t.name}</div><div className="truncate text-[11px] text-subtle">{t.subject || '(no subject)'} · {fmtAgo(t.updatedAt)}</div></div>
                  <div className="flex shrink-0 gap-0.5 opacity-60 group-hover:opacity-100">
                    {canSend && <Button size="icon" variant="ghost" aria-label="Use in campaign" onClick={() => router.push(`${base}/leads?emailTemplate=${t.id}`)}><Send /></Button>}
                    {canManage && <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => router.push(`${base}/email/templates/${t.id}`)}><Pencil /></Button>}
                    {canManage && <Button size="icon" variant="ghost" aria-label="Archive" onClick={() => setDel(t)}><Trash2 /></Button>}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
      {canManage && (
        <div>
          <h2 className="mb-2.5 text-[13.5px] font-medium">Start from a design</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {PRESETS.map((p) => (
              <Card key={p.key} className="overflow-hidden transition-colors hover:border-border-strong">
                <button className="block w-full text-left" onClick={() => router.push(`${base}/email/templates/new?preset=${p.key}`)}>
                  <EmailThumb design={p.design()} preheader={p.preheader} height={180} />
                  <div className="border-t border-border px-3 py-2.5"><div className="text-[12.5px] text-fg">{p.name}</div><div className="text-[11px] text-subtle">{p.description}</div></div>
                </button>
              </Card>
            ))}
          </div>
        </div>
      )}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Archive “${del?.name}”`} confirmLabel="Archive" danger onConfirm={() => remove.mutateAsync(del!.id)} />
    </div>
  );
}

const EMPTY_SENDER = { label: '', host: '', port: 587, secure: false, username: '', password: '', fromName: '', fromEmail: '', replyTo: '', dailyLimit: 500, perMinuteLimit: 30, isDefault: false };
const PROVIDERS: { name: string; host: string; port: number; secure: boolean }[] = [
  { name: 'Google Workspace / Gmail', host: 'smtp.gmail.com', port: 465, secure: true },
  { name: 'Microsoft 365 / Outlook', host: 'smtp.office365.com', port: 587, secure: false },
  { name: 'Amazon SES (us-east-1)', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false },
  { name: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, secure: false },
  { name: 'Mailgun', host: 'smtp.mailgun.org', port: 587, secure: false },
  { name: 'Postmark', host: 'smtp.postmarkapp.com', port: 587, secure: false },
  { name: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, secure: true },
];

function Senders({ canManage }: { canManage: boolean }) {
  const { data, isLoading } = useApiQuery<{ accounts: SenderRow[] }>('/api/v1/email/smtp');
  const [editing, setEditing] = useState<SenderRow | 'new' | null>(null);
  const [del, setDel] = useState<SenderRow | null>(null);
  const [health, setHealth] = useState<SenderRow | null>(null);
  const verify = useApiMutation((id: string) => api<{ ok: boolean; error: string | null }>(`/api/v1/email/smtp/${id}/verify`, { method: 'POST' }), {
    invalidate: ['/api/v1/email/smtp'], onSuccess: (r) => (r.ok ? toast.success('Connection verified — authentication succeeded') : toast.error(`Verification failed: ${r.error}`)),
  });
  const remove = useApiMutation((id: string) => api(`/api/v1/email/smtp/${id}`, { method: 'DELETE' }), { success: 'Sender removed', invalidate: ['/api/v1/email/smtp'] });
  const makeDefault = useApiMutation((a: SenderRow) => api(`/api/v1/email/smtp/${a.id}`, { method: 'PUT', body: { label: a.label, host: a.host, port: a.port, secure: a.secure, username: a.username, fromName: a.fromName, fromEmail: a.fromEmail, replyTo: a.replyTo, dailyLimit: a.dailyLimit, perMinuteLimit: a.perMinuteLimit, isDefault: true } }), { success: 'Default sender updated', invalidate: ['/api/v1/email/smtp'] });
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="max-w-2xl text-xs text-subtle">Connect your own mailboxes or email providers over SMTP. Passwords are encrypted at rest (AES-256-GCM) and never shown again. Sending respects each sender’s per-minute and daily limits.</p>
        {canManage && <Button variant="primary" onClick={() => setEditing('new')}><Plus /> Add sender</Button>}
      </div>
      {isLoading ? <Skeleton className="h-40" /> : !data?.accounts.length ? (
        <Card><EmptyState icon={MailPlus} title="No SMTP senders yet" description="Add a sender to start sending emails and campaigns." action={canManage && <Button variant="primary" size="sm" onClick={() => setEditing('new')}>Add sender</Button>} /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {data.accounts.map((a) => (
            <Card key={a.id}>
              <CardBody className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[13.5px] font-medium">{a.label}{a.isDefault && <Badge tone="solid"><Star className="size-2.5" /> Default</Badge>}</div>
                    <div className="truncate text-[12px] text-muted">{a.fromName} &lt;{a.fromEmail}&gt;</div>
                  </div>
                  {a.status === 'VERIFIED' ? <Badge tone="ok"><CheckCircle2 className="size-3" /> Verified</Badge> : a.status === 'FAILED' ? <Badge tone="danger"><CircleAlert className="size-3" /> Failed</Badge> : <Badge tone="warn"><Clock className="size-3" /> Unverified</Badge>}
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11.5px]">
                  <div><div className="text-subtle">Server</div><div className="truncate font-mono text-[11px]">{a.host}:{a.port}{a.secure ? ' · TLS' : ' · STARTTLS'}</div></div>
                  <div><div className="text-subtle">Limits</div><div className="tnum">{a.perMinuteLimit}/min · {fmtInt(a.dailyLimit)}/day</div></div>
                  <div><div className="text-subtle">Sent 24h</div><div className="tnum">{fmtInt(a.sentLast24h)} <span className="text-subtle">({fmtPct(a.sentLast24h / a.dailyLimit, 0)})</span></div></div>
                </div>
                {a.lastError && <InlineNotice tone="danger">{a.lastError}</InlineNotice>}
                {canManage && (
                  <div className="flex flex-wrap gap-1.5 border-t border-border pt-3">
                    <Button size="sm" onClick={() => verify.mutate(a.id)} loading={verify.isPending && verify.variables === a.id}><ShieldCheck /> Verify connection</Button>
                    <Button size="sm" onClick={() => setHealth(a)}><MailPlus /> Deliverability{a.deliverability ? <Badge tone={deliverabilityTone(a.deliverability.score)}>{a.deliverability.score}</Badge> : null}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(a)}><Pencil /> Edit</Button>
                    {!a.isDefault && <Button size="sm" variant="ghost" onClick={() => makeDefault.mutate(a)}><Star /> Make default</Button>}
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setDel(a)}><Trash2 /></Button>
                  </div>
                )}
                {a.lastVerifiedAt && <div className="text-[10.5px] text-subtle">Last checked {fmtAgo(a.lastVerifiedAt)}</div>}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      {editing && <SenderForm sender={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {health && <SenderDeliverability sender={health} onClose={() => setHealth(null)} />}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Remove “${del?.label}”`} danger confirmLabel="Remove" description="The stored password is destroyed. Past delivery logs are kept." onConfirm={() => remove.mutateAsync(del!.id)} />
    </>
  );
}

function SenderForm({ sender, onClose }: { sender: SenderRow | null; onClose: () => void }) {
  const [f, setF] = useState(sender ? { ...EMPTY_SENDER, ...sender, replyTo: sender.replyTo ?? '', password: '' } : EMPTY_SENDER);
  const [error, setError] = useState<string | null>(null);
  const save = useApiMutation(() => api(sender ? `/api/v1/email/smtp/${sender.id}` : '/api/v1/email/smtp', {
    method: sender ? 'PUT' : 'POST',
    body: { label: f.label, host: f.host, port: Number(f.port), secure: f.secure, username: f.username, ...(f.password ? { password: f.password } : {}), fromName: f.fromName, fromEmail: f.fromEmail, replyTo: f.replyTo || null, dailyLimit: Number(f.dailyLimit), perMinuteLimit: Number(f.perMinuteLimit), isDefault: f.isDefault },
  }), { success: 'Sender saved — verify the connection next', invalidate: ['/api/v1/email/smtp'], onSuccess: onClose });
  const inp = (k: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => <Field label={label}><Input value={String(f[k] ?? '')} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} /></Field>;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={sender ? `Edit ${sender.label}` : 'Add SMTP sender'} description="Use an app password where your provider supports it. Credentials are encrypted and only used by the sending worker." width="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => { setError(null); save.mutate(undefined, { onError: (e) => setError(errorMessage(e)) }); }}>Save sender</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Quick setup">
          <Select defaultValue="" onChange={(e) => { const p = PROVIDERS.find((x) => x.name === e.target.value); if (p) setF({ ...f, host: p.host, port: p.port, secure: p.secure, label: f.label || p.name }); }}>
            <option value="">Choose a provider to pre-fill server settings…</option>
            {PROVIDERS.map((p) => <option key={p.name}>{p.name}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {inp('label', 'Label', { placeholder: 'Sales team mailbox' })}
          <div className="grid grid-cols-[1fr_96px] gap-2">{inp('host', 'SMTP host', { placeholder: 'smtp.example.com' })}{inp('port', 'Port', { type: 'number' })}</div>
          {inp('username', 'Username')}
          {inp('password', sender ? 'Password (leave blank to keep)' : 'Password', { type: 'password', autoComplete: 'new-password' })}
          {inp('fromName', 'From name', { placeholder: 'Alex at Northwind' })}
          {inp('fromEmail', 'From email', { type: 'email' })}
          {inp('replyTo', 'Reply-to (optional)', { type: 'email' })}
          <label className="flex items-center justify-between self-end rounded-md border border-border px-3 py-2 text-[12.5px]">Implicit TLS (port 465)<Switch checked={f.secure} onCheckedChange={(v) => setF({ ...f, secure: v })} /></label>
          {inp('perMinuteLimit', 'Max per minute', { type: 'number', min: 1 })}
          {inp('dailyLimit', 'Max per day', { type: 'number', min: 1 })}
        </div>
        <label className="flex items-center justify-between text-[12.5px]">Use as default sender<Switch checked={f.isDefault} onCheckedChange={(v) => setF({ ...f, isDefault: v })} /></label>
        <InlineNotice>Port 587 uses STARTTLS; port 465 uses implicit TLS. For your domain’s deliverability, configure SPF, DKIM and DMARC with your provider.</InlineNotice>
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      </div>
    </Drawer>
  );
}
