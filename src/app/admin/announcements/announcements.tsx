'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRight, Bell, Megaphone, Send, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/data/data-table';
import { MultiFilter } from '@/components/data/quick-filters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtDateTime, fmtInt } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import type { Pricing } from '@/lib/pricing';

type Row = { id: string; kind: string; title: string; body: string | null; link: string | null; audience: { scope: string; organizationIds?: string[]; marketplaceOnly?: boolean }; recipientCount: number; orgCount: number; readCount: number; author: string; createdAt: string };
const LINKS = [['/app/marketplace', 'Lead marketplace'], ['/app', 'Dashboard'], ['/app/leads', 'My leads'], ['/app/billing', 'Billing'], ['', 'No link']] as const;

export function Announcements({ canPricing }: { canPricing: boolean }) {
  const orgs = useApiQuery<{ orgs: { id: string; name: string }[] }>('/api/v1/leads/facets');
  const pricing = useApiQuery<{ pricing: Pricing }>(canPricing ? '/api/v1/marketplace/pricing' : null);
  const [page, setPage] = useState(1);
  const history = useApiQuery<{ total: number; rows: Row[] }>(`/api/v1/announcements?page=${page}&pageSize=20`, { refetchInterval: 30_000 });
  const [f, setF] = useState({ title: '', body: '', link: '/app/marketplace', scope: 'ALL' as 'ALL' | 'ORGS', organizationIds: [] as string[], marketplaceOnly: false });
  const [confirm, setConfirm] = useState(false);
  const [announcing, setAnnouncing] = useState(false);
  const orgName = (id: string) => orgs.data?.orgs.find((o) => o.id === id)?.name ?? id;

  const send = async () => {
    const a = await api<Row>('/api/v1/announcements', { body: f });
    toast.success(`Sent to ${fmtInt(a.recipientCount)} people in ${fmtInt(a.orgCount)} workspace${a.orgCount === 1 ? '' : 's'}`);
    setF({ ...f, title: '', body: '' });
    history.refetch();
  };
  const announceNow = async () => {
    setAnnouncing(true);
    try {
      const r = await api<{ announcement: Row | null }>('/api/v1/announcements/new-leads', { method: 'POST' });
      if (r.announcement) toast.success(r.announcement.title, { description: `Sent to ${fmtInt(r.announcement.recipientCount)} people` });
      else toast('No new leads since the last announcement');
      history.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setAnnouncing(false);
    }
  };
  const toggleAuto = async (v: boolean) => {
    if (!pricing.data) return;
    try {
      await api('/api/v1/marketplace/pricing', { method: 'PUT', body: { ...pricing.data.pricing, autoAnnounce: v } });
      toast.success(v ? 'New leads will be announced automatically' : 'Automatic announcements turned off');
      pricing.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const cols: ColumnDef<Row, unknown>[] = [
    { id: 'when', header: 'Sent', cell: ({ row: { original: r } }) => <span className="whitespace-nowrap text-subtle">{fmtDateTime(r.createdAt)}</span> },
    { id: 'kind', header: 'Type', cell: ({ row: { original: r } }) => (r.kind === 'NEW_LEADS' ? <Badge tone="solid"><Sparkles className="size-3" />New leads</Badge> : <Badge tone="outline"><Megaphone className="size-3" />Announcement</Badge>) },
    { id: 'title', header: 'Message', cell: ({ row: { original: r } }) => <div className="max-w-[420px]"><div className="truncate text-fg">{r.title}</div>{r.body && <div className="truncate text-[11px] text-subtle">{r.body}</div>}</div> },
    { id: 'aud', header: 'Audience', cell: ({ row: { original: r } }) => <span className="text-muted">{r.audience.scope === 'ALL' ? 'All workspaces' : (r.audience.organizationIds ?? []).map(orgName).join(', ')}{r.audience.marketplaceOnly && <span className="text-subtle"> · marketplace users</span>}</span> },
    { id: 'reach', header: 'Reach', cell: ({ row: { original: r } }) => <span className="tnum">{fmtInt(r.recipientCount)} <span className="text-subtle">· {r.recipientCount ? Math.round((r.readCount / r.recipientCount) * 100) : 0}% read</span></span> },
    { id: 'by', header: 'By', cell: ({ row: { original: r } }) => <span className="text-subtle">{r.author}</span> },
  ];

  return (
    <>
      <PageHeader title="Announcements" description="Send notifications to client dashboards — they appear in each user's notification bell and as a banner on their dashboard." />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader title="New announcement" />
          <CardBody className="flex flex-col gap-4">
            <Field label="Title"><Input value={f.title} maxLength={140} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. 500 fresh solar leads just landed" /></Field>
            <Field label="Message (optional)"><Textarea rows={3} value={f.body} maxLength={600} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="A short note for your clients" /></Field>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Button opens"><Select value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })}>{LINKS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}</Select></Field>
              <Field label="Send to">
                <div className="flex rounded-md border border-border-strong p-0.5">
                  {(['ALL', 'ORGS'] as const).map((sc) => <button key={sc} type="button" onClick={() => setF({ ...f, scope: sc })} className={cn('h-7 flex-1 rounded text-[12px]', f.scope === sc ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{sc === 'ALL' ? 'All workspaces' : 'Selected workspaces'}</button>)}
                </div>
              </Field>
            </div>
            {f.scope === 'ORGS' && (
              <div className="flex flex-wrap items-center gap-2">
                <MultiFilter label="Workspaces" field="org" options={(orgs.data?.orgs ?? []).map((o) => ({ value: o.id, label: o.name }))} conditions={f.organizationIds.length ? [{ field: 'org', op: 'in', value: f.organizationIds }] : []} onChange={(cs) => setF({ ...f, organizationIds: (cs.find((c) => c.field === 'org')?.value as string[] | undefined) ?? [] })} />
                {f.organizationIds.map((id) => <Badge key={id} tone="outline">{orgName(id)}</Badge>)}
              </div>
            )}
            <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-[12.5px]">
              <span><span className="block font-medium">Only people who can use the marketplace</span><span className="block text-[11.5px] text-subtle">Otherwise every active member of the chosen workspaces is notified.</span></span>
              <Switch checked={f.marketplaceOnly} onCheckedChange={(v) => setF({ ...f, marketplaceOnly: v })} aria-label="Marketplace users only" />
            </label>
            <div className="flex justify-end"><Button variant="primary" disabled={f.title.trim().length < 3 || (f.scope === 'ORGS' && !f.organizationIds.length)} onClick={() => setConfirm(true)}><Send /> Send announcement</Button></div>
          </CardBody>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Preview" description="How clients see it" />
            <CardBody className="flex flex-col gap-3">
              <div className="flex items-start gap-3 rounded-lg border border-fg/80 bg-surface px-3.5 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-fg text-inverse"><Megaphone className="size-4" /></span>
                <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium">{f.title || 'Your title'}</div>{f.body && <p className="mt-0.5 line-clamp-3 text-[12px] text-muted">{f.body}</p>}</div>
                {f.link && <span className="flex shrink-0 items-center gap-1 self-center rounded-md bg-fg px-2.5 py-1 text-[11.5px] text-inverse">Open <ArrowRight className="size-3" /></span>}
              </div>
              <div className="flex items-start gap-2.5 rounded-md border border-border bg-surface-2 px-3 py-2"><Bell className="mt-0.5 size-3.5 text-subtle" /><div className="min-w-0"><div className="truncate text-[12px]">{f.title || 'Your title'}</div><div className="text-[10.5px] text-subtle">Notification bell · just now</div></div></div>
            </CardBody>
          </Card>
          {canPricing && (
            <Card>
              <CardHeader title="New-lead announcements" description="Sent automatically a couple of minutes after an import completes or leads are added manually, summarising what became available in the marketplace." />
              <CardBody className="flex flex-col gap-3">
                <label className="flex items-center justify-between text-[12.5px]"><span className="font-medium">Announce automatically</span><Switch checked={pricing.data?.pricing.autoAnnounce ?? false} disabled={!pricing.data} onCheckedChange={toggleAuto} aria-label="Announce automatically" /></label>
                <Button variant="outline" loading={announcing} onClick={announceNow}><Sparkles /> Announce new leads now</Button>
              </CardBody>
            </Card>
          )}
        </div>
      </div>

      <h2 className="mt-7 mb-3 text-[14px] font-medium">History</h2>
      <DataTable columns={cols} data={history.data?.rows ?? []} total={history.data?.total ?? 0} page={page} pageSize={20} onPage={setPage} loading={history.isFetching} getRowId={(r) => r.id} dense empty={<div className="py-10 text-center text-[12.5px] text-subtle">Nothing sent yet.</div>} />

      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Send announcement" confirmLabel="Send"
        description={`“${f.title}” will be sent to ${f.scope === 'ALL' ? 'every active workspace' : `${f.organizationIds.length} workspace(s)`}${f.marketplaceOnly ? ' (marketplace users only)' : ''}. Notifications cannot be recalled.`}
        onConfirm={send} />
    </>
  );
}
