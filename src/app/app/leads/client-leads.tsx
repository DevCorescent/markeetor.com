'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { Archive, Mail, Search, Store, Tag, Undo2, UserRoundCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { DataTable, emptySelection, type SelectionState } from '@/components/data/data-table';
import { FilterBuilder } from '@/components/data/filter-builder';
import { ResearchScore, type ResearchInfo } from '@/components/company/research-score';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button, buttonClass } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page';
import { api, errorMessage } from '@/lib/api-client';
import type { Condition, FilterField } from '@/lib/filters';
import { fmtAgo, fmtDateTime, fmtInt, fmtMoney } from '@/lib/format';
import { useApiMutation, useApiQuery, useUrlState } from '@/lib/hooks';

type Row = { id: string; fullName: string; email: string | null; phone: string | null; company: string | null; jobTitle: string | null; city: string | null; country: string | null; source: string | null; campaign: string | null; score: number; priority: string; status: string; owner: { id: string; name: string } | null; stage: { id: string; name: string } | null; dealValue: number | null; currency: string; nextFollowUpAt: string | null; lastActivityAt: string | null; firstContactAt: string | null; createdAt: string; tags: { id: string; name: string }[]; research?: ResearchInfo };
export type ClientFacets = { sources: string[]; campaigns: string[]; industries: string[]; countries: string[]; tags: { id: string; name: string }[]; members: { id: string; name: string; role: string }[]; stages: { id: string; name: string; category: string }[]; fields: { key: string; label: string; type: string; options: string[]; required: boolean }[] };

const opt = (xs: string[]) => xs.map((x) => ({ value: x, label: x }));
const STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'NEGOTIATION', 'CONVERTED', 'LOST'];

export function clientLeadFields(f: ClientFacets | undefined, all: boolean): FilterField[] {
  return [
    { key: 'fullName', label: 'Name', type: 'text' }, { key: 'company', label: 'Company', type: 'text' }, { key: 'jobTitle', label: 'Job title', type: 'text' }, { key: 'city', label: 'City', type: 'text' },
    { key: 'status', label: 'Status', type: 'enum', options: opt(STATUSES) },
    { key: 'priority', label: 'Priority', type: 'enum', options: opt(['LOW', 'MEDIUM', 'HIGH', 'URGENT']) },
    { key: 'stageId', label: 'Stage', type: 'enum', options: (f?.stages ?? []).map((s) => ({ value: s.id, label: s.name })) },
    ...(all ? [{ key: 'ownerId', label: 'Owner', type: 'enum' as const, options: (f?.members ?? []).map((m) => ({ value: m.id, label: m.name })) }] : []),
    { key: 'source', label: 'Source', type: 'enum', options: opt(f?.sources ?? []) }, { key: 'campaign', label: 'Campaign', type: 'enum', options: opt(f?.campaigns ?? []) },
    { key: 'industry', label: 'Industry', type: 'enum', options: opt(f?.industries ?? []) }, { key: 'country', label: 'Country', type: 'enum', options: opt(f?.countries ?? []) },
    { key: 'tag', label: 'Tag', type: 'enum', options: (f?.tags ?? []).map((t) => ({ value: t.id, label: t.name })) },
    { key: 'score', label: 'Score', type: 'number' },
    { key: 'nextFollowUpAt', label: 'Next follow-up', type: 'date' }, { key: 'firstContactAt', label: 'First contact', type: 'date' },
    { key: 'lastActivityAt', label: 'Last activity', type: 'date' }, { key: 'createdAt', label: 'Allocated', type: 'date' },
  ];
}

const columns: ColumnDef<Row, unknown>[] = [
  { id: 'fullName', header: 'Lead', enableHiding: false, cell: ({ row: { original: r } }) => <div className="min-w-[170px]"><Link href={`/app/leads/${r.id}`} onClick={(e) => e.stopPropagation()} className="block truncate text-fg hover:underline">{r.fullName}</Link><div className="truncate text-[11px] text-subtle">{r.company ?? '—'}{r.jobTitle ? ` · ${r.jobTitle}` : ''}</div></div> },
  { id: 'status', header: 'Status', cell: ({ row: { original: r } }) => <div className="flex flex-col gap-0.5"><StatusBadge status={r.status} />{r.stage && <span className="text-[10.5px] text-subtle">{r.stage.name}</span>}</div> },
  { id: 'priority', header: 'Priority', cell: ({ row: { original: r } }) => <StatusBadge status={r.priority} /> },
  { id: 'owner', header: 'Owner', enableSorting: false, cell: ({ row: { original: r } }) => (r.owner ? r.owner.name : <span className="text-subtle">Unassigned</span>) },
  { id: 'dealValue', header: 'Deal', cell: ({ row: { original: r } }) => <span className="tnum">{r.dealValue ? fmtMoney(r.dealValue, r.currency) : '—'}</span> },
  { id: 'nextFollowUpAt', header: 'Follow-up', cell: ({ row: { original: r } }) => (r.nextFollowUpAt ? <span className={new Date(r.nextFollowUpAt) < new Date() ? 'text-warn' : ''}>{fmtDateTime(r.nextFollowUpAt)}</span> : <span className="text-subtle">—</span>) },
  { id: 'source', header: 'Source', enableSorting: false, cell: ({ row: { original: r } }) => <span className="text-muted">{r.source ?? '—'}</span> },
  { id: 'research', header: 'Research', enableSorting: false, cell: ({ row: { original: r } }) => <ResearchScore r={r.research} /> },
  { id: 'score', header: 'Score', cell: ({ row: { original: r } }) => <span className="tnum">{r.score}</span> },
  { id: 'tags', header: 'Tags', enableSorting: false, cell: ({ row: { original: r } }) => <div className="flex gap-1">{r.tags.slice(0, 2).map((t) => <Badge key={t.id} tone="outline">{t.name}</Badge>)}</div> },
  { id: 'lastActivityAt', header: 'Last activity', cell: ({ row: { original: r } }) => <span className="text-subtle">{r.lastActivityAt ? fmtAgo(r.lastActivityAt) : '—'}</span> },
  { id: 'createdAt', header: 'Allocated', cell: ({ row: { original: r } }) => <span className="text-subtle">{fmtAgo(r.createdAt)}</span> },
];

export function ClientLeads({ perms }: { perms: { all: boolean; assign: boolean; bulk: boolean; update: boolean; archive: boolean; email: boolean; marketplace?: boolean } }) {
  const router = useRouter();
  const [s, set] = useUrlState({ q: '', filter: '', view: 'active', page: '1', sort: '' });
  const [qInput, setQInput] = useState(s.q ?? '');
  const [sel, setSel] = useState<SelectionState>(emptySelection());
  const [cols, setCols] = useState<Record<string, boolean>>({ score: false, lastActivityAt: false });
  const [dlg, setDlg] = useState<null | 'assign' | 'status' | 'tag' | 'archive' | 'restore'>(null);
  const [assignee, setAssignee] = useState('');
  const [status, setStatus] = useState('CONTACTED');
  const [lostReason, setLostReason] = useState('');
  const [tags, setTags] = useState('');
  const facets = useApiQuery<ClientFacets>('/api/v1/crm/leads/facets');
  useEffect(() => {
    const t = setTimeout(() => qInput !== (s.q ?? '') && set({ q: qInput, page: '1' }), 300);
    return () => clearTimeout(t);
  }, [qInput]); // eslint-disable-line react-hooks/exhaustive-deps
  const conditions: Condition[] = useMemo(() => { try { return s.filter ? JSON.parse(s.filter).conditions ?? [] : []; } catch { return []; } }, [s.filter]);
  const url = `/api/v1/crm/leads?page=${s.page}&pageSize=50&view=${s.view}&filter=${encodeURIComponent(JSON.stringify({ q: s.q || undefined, conditions }))}${s.sort ? `&sort=${encodeURIComponent(s.sort)}` : ''}`;
  const { data, isFetching, error } = useApiQuery<{ total: number; rows: Row[] }>(url);
  useEffect(() => setSel(emptySelection()), [url]);
  const ids = [...sel.ids];
  const bulk = useApiMutation((b: object) => api<{ updated: number }>('/api/v1/crm/leads/bulk', { body: b }), { success: (r) => `${fmtInt(r.updated)} lead(s) updated`, invalidate: ['/api/v1/crm'], onSuccess: () => { setSel(emptySelection()); setDlg(null); } });
  const canBulk = perms.assign || perms.bulk || perms.archive || perms.update || perms.email;
  const startEmail = (audience: Record<string, unknown>, label: string, count: number) => {
    sessionStorage.setItem('lcrm.email.audience', JSON.stringify({ audience, label, count }));
    const tpl = new URLSearchParams(window.location.search).get('emailTemplate');
    router.push(`/app/email/compose${tpl ? `?template=${tpl}` : ''}`);
  };

  return (
    <>
      <PageHeader title="My leads" description={perms.all ? 'Leads allotted to your workspace. Contact details are masked until revealed; reveals are logged.' : 'Leads assigned to you. Contact details are masked until revealed; reveals are logged.'}
        actions={perms.marketplace ? <Link href="/app/marketplace" className={buttonClass({ variant: 'outline', size: 'sm' })}><Store /> Get more leads</Link> : undefined} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs"><Search className="absolute top-2 left-2.5 size-3.5 text-subtle" /><Input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search name or company…" className="pl-8" aria-label="Search" /></div>
        {perms.email && (data?.total ?? 0) > 0 && (
          <Button size="sm" variant="ghost" className="order-last ml-auto" onClick={() => startEmail({ kind: 'workspace', filter: { q: s.q || undefined, conditions }, view: s.view }, `All ${fmtInt(data!.total)} matching leads`, data!.total)}><Mail /> Email all {fmtInt(data?.total ?? 0)} matching</Button>
        )}
        <div className="flex items-center rounded-md border border-border bg-surface p-0.5" role="group">
          {[['active', 'Active'], ...(perms.all ? [['unassigned', 'Unassigned']] : []), ['archived', 'Archived']].map(([v, l]) => <button key={v} onClick={() => set({ view: v, page: '1' })} aria-pressed={s.view === v} className={`h-6 rounded px-2 text-[11.5px] ${s.view === v ? 'bg-fg text-inverse' : 'text-muted hover:text-fg'}`}>{l}</button>)}
        </div>
      </div>
      {ids.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border-strong bg-surface-2 px-3 py-2">
          <span className="tnum mr-2 text-[12.5px]">{ids.length} selected</span>
          {perms.assign && <Button size="sm" variant="primary" onClick={() => setDlg('assign')}><UserRoundCheck /> Assign</Button>}
          {perms.email && <Button size="sm" onClick={() => startEmail({ kind: 'workspace', ids }, `${ids.length} selected lead${ids.length === 1 ? '' : 's'}`, ids.length)}><Mail /> Email</Button>}
          {perms.update && (perms.bulk || ids.length === 1) && <Button size="sm" onClick={() => setDlg('status')}>Set status</Button>}
          {perms.update && <Button size="sm" onClick={() => setDlg('tag')}><Tag /> Tag</Button>}
          {perms.archive && s.view !== 'archived' && <Button size="sm" variant="ghost" onClick={() => setDlg('archive')}><Archive /> Archive</Button>}
          {perms.archive && s.view === 'archived' && <Button size="sm" variant="ghost" onClick={() => setDlg('restore')}><Undo2 /> Restore</Button>}
        </div>
      )}
      <DataTable
        columns={columns} data={data?.rows ?? []} total={data?.total ?? 0} page={Number(s.page)} pageSize={50} onPage={(p) => set({ page: String(p) })}
        sort={s.sort ? JSON.parse(s.sort) : null} onSort={(v) => set({ sort: v ? JSON.stringify(v) : '', page: '1' })}
        loading={isFetching} error={error ? errorMessage(error) : null} getRowId={(r) => r.id}
        selection={canBulk ? { ...sel, all: false } : undefined} onSelection={canBulk ? (v) => setSel(v.all ? { all: false, ids: new Set([...(data?.rows ?? []).map((r) => r.id)]), excluded: new Set() } : v) : undefined}
        columnVisibility={cols} onColumnVisibility={setCols}
        onRowClick={(r) => router.push(`/app/leads/${r.id}`)}
        toolbar={<FilterBuilder fields={clientLeadFields(facets.data, perms.all)} value={conditions} onChange={(c) => set({ filter: c.length ? JSON.stringify({ conditions: c }) : '', page: '1' })} />}
      />
      <ConfirmDialog open={dlg === 'assign'} onOpenChange={(o) => !o && setDlg(null)} title={`Assign ${ids.length} lead(s)`} confirmLabel="Assign" onConfirm={() => bulk.mutateAsync({ action: 'assign', ids, ownerId: assignee || null })}>
        <Field label="Owner"><Select value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Unassigned</option>{facets.data?.members.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.role}</option>)}</Select></Field>
      </ConfirmDialog>
      <ConfirmDialog open={dlg === 'status'} onOpenChange={(o) => !o && setDlg(null)} title={`Set status for ${ids.length} lead(s)`} confirmLabel="Update" onConfirm={() => bulk.mutateAsync({ action: 'status', ids, status, lostReason: status === 'LOST' ? lostReason : undefined })}>
        <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map((x) => <option key={x} value={x}>{x[0] + x.slice(1).toLowerCase()}</option>)}</Select></Field>
        {status === 'LOST' && <Field label="Lost reason"><Input value={lostReason} onChange={(e) => setLostReason(e.target.value)} /></Field>}
      </ConfirmDialog>
      <ConfirmDialog open={dlg === 'tag'} onOpenChange={(o) => !o && setDlg(null)} title={`Tag ${ids.length} lead(s)`} confirmLabel="Apply" onConfirm={() => bulk.mutateAsync({ action: 'tag', ids, add: tags.split(',').map((t) => t.trim()).filter(Boolean) })}>
        <Field label="Tags" hint="Comma-separated; new tags are created in your workspace"><Input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
      </ConfirmDialog>
      <ConfirmDialog open={dlg === 'archive'} onOpenChange={(o) => !o && setDlg(null)} title={`Archive ${ids.length} lead(s)`} danger confirmLabel="Archive" onConfirm={() => bulk.mutateAsync({ action: 'archive', ids })} />
      <ConfirmDialog open={dlg === 'restore'} onOpenChange={(o) => !o && setDlg(null)} title={`Restore ${ids.length} lead(s)`} confirmLabel="Restore" onConfirm={() => bulk.mutateAsync({ action: 'restore', ids })} />
    </>
  );
}
