'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { Archive, Bookmark, Download, Mail, Plus, RotateCcw, Search, Shuffle, Sparkles, Tag, Undo2, Users2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DataTable, emptySelection, selectionCount, type SelectionState } from '@/components/data/data-table';
import { FilterBuilder } from '@/components/data/filter-builder';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { InlineNotice } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import type { Condition, FilterField, Selection } from '@/lib/filters';
import { fmtAgo, fmtDate, fmtInt } from '@/lib/format';
import { useApiMutation, useApiQuery, useUrlState } from '@/lib/hooks';
import { DuplicateReview } from './duplicate-review';
import { EnrichDialog, EnrichmentPanel, ResearchBadge } from './enrichment-panel';

export type LeadRow = {
  id: string; fullName: string; email: string | null; phone: string | null; company: string | null; jobTitle: string | null; country: string | null; city: string | null;
  industry: string | null; source: string | null; campaign: string | null; score: number; priority: string; quality: string; allocationStatus: string;
  assignedOrganization: string | null; clientStatus: string | null; duplicateOfId: string | null; createdAt: string; lastActivityAt: string | null; archivedAt: string | null; tags: { id: string; name: string }[];
  enrichment: { status: string; confidence: number } | null;
};
type Facets = { sources: string[]; campaigns: string[]; industries: string[]; countries: string[]; tags: { id: string; name: string }[]; orgs: { id: string; name: string }[]; imports: { id: string; code: string; fileName: string }[] };
type Perms = { update: boolean; archive: boolean; merge: boolean; export: boolean; distribute: boolean; reassign: boolean; email: boolean; enrich: boolean };

const opt = (xs: string[]) => xs.map((x) => ({ value: x, label: x }));

export function leadFields(f?: Facets): FilterField[] {
  return [
    { key: 'fullName', label: 'Name', type: 'text' },
    { key: 'company', label: 'Company', type: 'text' },
    { key: 'email', label: 'Email', type: 'text' },
    { key: 'phone', label: 'Phone', type: 'text' },
    { key: 'jobTitle', label: 'Job title', type: 'text' },
    { key: 'city', label: 'City', type: 'text' },
    { key: 'country', label: 'Country', type: 'enum', options: opt(f?.countries ?? []) },
    { key: 'industry', label: 'Industry', type: 'enum', options: opt(f?.industries ?? []) },
    { key: 'source', label: 'Source', type: 'enum', options: opt(f?.sources ?? []) },
    { key: 'campaign', label: 'Campaign', type: 'enum', options: opt(f?.campaigns ?? []) },
    { key: 'score', label: 'Score', type: 'number' },
    { key: 'priority', label: 'Priority', type: 'enum', options: opt(['LOW', 'MEDIUM', 'HIGH', 'URGENT']) },
    { key: 'quality', label: 'Quality', type: 'enum', options: opt(['VALID', 'INVALID']) },
    { key: 'allocationStatus', label: 'Allocation', type: 'enum', options: opt(['UNALLOCATED', 'PENDING', 'ALLOCATED']) },
    { key: 'assignedOrganizationId', label: 'Assigned client', type: 'enum', options: (f?.orgs ?? []).map((o) => ({ value: o.id, label: o.name })) },
    { key: 'clientStatus', label: 'Client status', type: 'enum', options: opt(['NEW', 'CONTACTED', 'QUALIFIED', 'NEGOTIATION', 'CONVERTED', 'LOST']) },
    { key: 'tag', label: 'Tag', type: 'enum', options: (f?.tags ?? []).map((t) => ({ value: t.id, label: t.name })) },
    { key: 'importBatchId', label: 'Import batch', type: 'enum', options: (f?.imports ?? []).map((i) => ({ value: i.id, label: `${i.code} · ${i.fileName}` })) },
    { key: 'duplicate', label: 'Flagged duplicate', type: 'boolean' },
    { key: 'enrichment', label: 'AI research', type: 'enum', options: [{ value: 'DONE', label: 'Researched' }, { value: 'PARTIAL', label: 'Partial' }, { value: 'FAILED', label: 'Failed' }, { value: 'QUEUED', label: 'Queued' }, { value: 'RUNNING', label: 'Running' }] },
    { key: 'keyword', label: 'Business keyword', type: 'text' },
    { key: 'createdAt', label: 'Created', type: 'date' },
    { key: 'lastActivityAt', label: 'Last activity', type: 'date' },
    { key: 'distributionCount', label: 'Times distributed', type: 'number' },
    { key: 'lastDistributedAt', label: 'Last distributed', type: 'date' },
    { key: 'everClient', label: 'Ever sent to client', type: 'enum', options: (f?.orgs ?? []).map((o) => ({ value: o.id, label: o.name })) },
  ];
}

const COLUMNS: ColumnDef<LeadRow, unknown>[] = [
  {
    id: 'fullName', header: 'Lead', enableHiding: false,
    cell: ({ row: { original: r } }) => (
      <div className="min-w-[180px]">
        <Link href={`/admin/leads/${r.id}`} onClick={(e) => e.stopPropagation()} className="block truncate text-fg hover:underline">{r.fullName}</Link>
        <div className="truncate text-[11px] text-subtle">{r.email ?? r.phone ?? 'No contact'}</div>
      </div>
    ),
  },
  { id: 'company', header: 'Company', cell: ({ row: { original: r } }) => <div className="max-w-[200px] truncate">{r.company ?? '—'}<div className="truncate text-[11px] text-subtle">{r.jobTitle}</div></div> },
  { id: 'country', header: 'Location', cell: ({ row: { original: r } }) => <span className="text-muted">{[r.city, r.country].filter(Boolean).join(', ') || '—'}</span> },
  { id: 'industry', header: 'Industry', enableSorting: false, cell: ({ row: { original: r } }) => r.industry ?? '—' },
  { id: 'research', header: 'Research', enableSorting: false, cell: ({ row: { original: r } }) => <ResearchBadge e={r.enrichment} /> },
  { id: 'source', header: 'Source', cell: ({ row: { original: r } }) => <div className="max-w-[160px] truncate">{r.source ?? '—'}<div className="truncate text-[11px] text-subtle">{r.campaign}</div></div> },
  { id: 'score', header: 'Score', cell: ({ row: { original: r } }) => <span className="tnum">{r.score}</span> },
  { id: 'priority', header: 'Priority', cell: ({ row: { original: r } }) => <StatusBadge status={r.priority} /> },
  {
    id: 'allocation', header: 'Allocation', enableSorting: false,
    cell: ({ row: { original: r } }) => (
      <div className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5"><StatusBadge status={r.allocationStatus} />{r.quality === 'INVALID' && <Badge tone="danger">Invalid</Badge>}{r.duplicateOfId && <Badge tone="warn">Dup</Badge>}</span>
        {r.assignedOrganization && <span className="max-w-[170px] truncate text-[11px] text-subtle">{r.assignedOrganization}{r.clientStatus ? ` · ${r.clientStatus.toLowerCase()}` : ''}</span>}
      </div>
    ),
  },
  { id: 'tags', header: 'Tags', enableSorting: false, cell: ({ row: { original: r } }) => <div className="flex max-w-[180px] gap-1 overflow-hidden">{r.tags.slice(0, 3).map((t) => <Badge key={t.id} tone="outline">{t.name}</Badge>)}{r.tags.length > 3 && <span className="text-[11px] text-subtle">+{r.tags.length - 3}</span>}</div> },
  { id: 'createdAt', header: 'Created', cell: ({ row: { original: r } }) => <span className="text-subtle" title={r.createdAt}>{fmtDate(r.createdAt)}</span> },
  { id: 'lastActivityAt', header: 'Last activity', cell: ({ row: { original: r } }) => <span className="text-subtle">{r.lastActivityAt ? fmtAgo(r.lastActivityAt) : '—'}</span> },
];

const COLS_KEY = 'lcrm.admin.leads.columns';

export function LeadRepository({ perms }: { perms: Perms }) {
  const router = useRouter();
  const [s, set] = useUrlState({ tab: 'repository', q: '', filter: '', view: 'active', page: '1', pageSize: '50', sort: '' });
  const [qInput, setQInput] = useState(s.q ?? '');
  const [selection, setSelection] = useState<SelectionState>(emptySelection());
  const [cols, setCols] = useState<Record<string, boolean>>({ industry: false, lastActivityAt: false });
  const [dialog, setDialog] = useState<null | 'archive' | 'restore' | 'tag' | 'export' | 'create' | 'reassign' | 'revoke' | 'saveView' | 'enrich'>(null);

  useEffect(() => {
    try {
      const v = localStorage.getItem(COLS_KEY);
      if (v) setCols(JSON.parse(v));
    } catch {}
  }, []);
  useEffect(() => {
    const t = setTimeout(() => qInput !== (s.q ?? '') && set({ q: qInput, page: '1' }), 300);
    return () => clearTimeout(t);
  }, [qInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const conditions: Condition[] = useMemo(() => {
    try {
      return s.filter ? JSON.parse(s.filter).conditions ?? [] : [];
    } catch {
      return [];
    }
  }, [s.filter]);
  const filterObj = useMemo(() => ({ q: s.q || undefined, conditions }), [s.q, conditions]);
  const sort = s.sort ? (JSON.parse(s.sort) as { id: string; desc: boolean }) : null;
  const url = `/api/v1/leads?page=${s.page}&pageSize=${s.pageSize}&view=${s.view}&filter=${encodeURIComponent(JSON.stringify(filterObj))}${s.sort ? `&sort=${encodeURIComponent(s.sort)}` : ''}`;
  const { data, isFetching, error } = useApiQuery<{ total: number; rows: LeadRow[] }>(s.tab === 'repository' ? url : null);
  const facets = useApiQuery<Facets>('/api/v1/leads/facets');
  const views = useApiQuery<{ views: { id: string; name: string; state: Record<string, string> }[] }>('/api/v1/views?scope=ADMIN_LEADS');
  const fields = useMemo(() => leadFields(facets.data), [facets.data]);

  useEffect(() => setSelection(emptySelection()), [url]);
  const total = data?.total ?? 0;
  const count = selectionCount(selection, total);
  const sel: Selection | null = count === 0 ? null : selection.all ? { mode: 'filter', filter: filterObj, excludeIds: [...selection.excluded] } : { mode: 'ids', ids: [...selection.ids] };

  const bulk = useApiMutation((body: Record<string, unknown>) => api<{ updated: number; skipped?: number }>('/api/v1/leads/bulk', { body }), {
    success: (r) => `${fmtInt(r.updated)} updated${r.skipped ? ` · ${r.skipped} skipped (allocated)` : ''}`,
    invalidate: ['/api/v1/leads'],
    onSuccess: () => { setSelection(emptySelection()); setDialog(null); },
  });

  const emailSelection = () => {
    if (!sel) return;
    sessionStorage.setItem('lcrm.email.audience', JSON.stringify({ audience: { kind: 'platform', selection: sel }, label: selection.all ? `All ${fmtInt(count)} matching leads` : `${fmtInt(count)} selected leads`, count }));
    const tpl = new URLSearchParams(window.location.search).get('emailTemplate');
    router.push(`/admin/email/compose${tpl ? `?template=${tpl}` : ''}`);
  };

  const distribute = () => {
    if (!sel) return;
    sessionStorage.setItem('lcrm.distribution.selection', JSON.stringify({ selection: sel, count, label: selection.all ? 'all matching leads' : `${count} selected leads` }));
    router.push('/admin/distribution?tab=new&from=leads');
  };

  return (
    <>
      <PageHeader
        title="Lead repository"
        description="Every master lead record on the platform. Contact details are masked; reveals are permission-checked and audited."
        actions={
          <>
            {perms.export && <Button variant="ghost" onClick={() => setDialog('export')}><Download /> Export</Button>}
            {perms.update && <Button variant="secondary" onClick={() => setDialog('create')}><Plus /> Add lead</Button>}
            <Button variant="primary" onClick={() => router.push('/admin/imports')}>Import leads</Button>
          </>
        }
      />
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}>
        <TabsList className="mb-4">
          <TabsTrigger value="repository">Repository</TabsTrigger>
          {perms.merge && <TabsTrigger value="duplicates">Duplicate review</TabsTrigger>}
          <TabsTrigger value="enrichment">AI research</TabsTrigger>
        </TabsList>
      </Tabs>
      {s.tab === 'enrichment' ? <EnrichmentPanel canRun={perms.enrich} /> : s.tab === 'duplicates' ? <DuplicateReview /> : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-xs">
              <Search className="absolute top-2 left-2.5 size-3.5 text-subtle" />
              <Input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search name, company, email, phone…" className="pl-8" aria-label="Search leads" />
            </div>
            <div className="flex items-center rounded-md border border-border bg-surface p-0.5" role="group" aria-label="View">
              {['active', 'archived', 'all'].map((v) => (
                <button key={v} onClick={() => set({ view: v, page: '1' })} aria-pressed={s.view === v} className={`h-6 rounded px-2 text-[11.5px] capitalize ${s.view === v ? 'bg-fg text-inverse' : 'text-muted hover:text-fg'}`}>{v}</button>
              ))}
            </div>
            <Menu>
              <MenuTrigger asChild><Button size="sm" variant="ghost"><Bookmark /> Views</Button></MenuTrigger>
              <MenuContent align="start">
                <MenuLabel>Saved views</MenuLabel>
                {views.data?.views.length ? views.data.views.map((v) => (
                  <MenuItem key={v.id} onSelect={() => set({ ...v.state, page: '1' })}>{v.name}</MenuItem>
                )) : <div className="px-2 py-1.5 text-xs text-subtle">None yet</div>}
                <MenuSeparator />
                <MenuItem onSelect={() => setDialog('saveView')}><Plus /> Save current view</MenuItem>
                {views.data?.views.map((v) => <MenuItem key={`d${v.id}`} onSelect={() => api(`/api/v1/views/${v.id}`, { method: 'DELETE' }).then(() => views.refetch())}><X /> Delete “{v.name}”</MenuItem>)}
              </MenuContent>
            </Menu>
          </div>
          {count > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border-strong bg-surface-2 px-3 py-2">
              <span className="tnum mr-2 text-[12.5px]">{fmtInt(count)} selected</span>
              {perms.distribute && <Button size="sm" variant="primary" onClick={distribute}><Shuffle /> Distribute</Button>}
              {perms.email && <Button size="sm" onClick={emailSelection}><Mail /> Email</Button>}
              {perms.enrich && <Button size="sm" onClick={() => setDialog('enrich')}><Sparkles /> Research with AI</Button>}
              {perms.update && <Button size="sm" onClick={() => setDialog('tag')}><Tag /> Tag</Button>}
              {perms.archive && s.view !== 'archived' && <Button size="sm" onClick={() => setDialog('archive')}><Archive /> Archive</Button>}
              {perms.archive && s.view !== 'active' && <Button size="sm" onClick={() => setDialog('restore')}><Undo2 /> Restore</Button>}
              {perms.reassign && <Button size="sm" onClick={() => setDialog('reassign')}><Users2 /> Reassign</Button>}
              {perms.reassign && <Button size="sm" variant="ghost" onClick={() => setDialog('revoke')}><RotateCcw /> Revoke</Button>}
            </div>
          )}
          <DataTable
            columns={COLUMNS}
            data={data?.rows ?? []}
            total={total}
            page={Number(s.page)}
            pageSize={Number(s.pageSize)}
            onPage={(p) => set({ page: String(p) })}
            sort={sort}
            onSort={(v) => set({ sort: v ? JSON.stringify(v) : '', page: '1' })}
            loading={isFetching}
            error={error ? errorMessage(error) : null}
            getRowId={(r) => r.id}
            selection={selection}
            onSelection={setSelection}
            columnVisibility={cols}
            onColumnVisibility={(v) => { setCols(v); try { localStorage.setItem(COLS_KEY, JSON.stringify(v)); } catch {} }}
            onRowClick={(r) => router.push(`/admin/leads/${r.id}`)}
            toolbar={<FilterBuilder fields={fields} value={conditions} onChange={(c) => set({ filter: c.length ? JSON.stringify({ conditions: c }) : '', page: '1' })} />}
          />
        </>
      )}

      {dialog === 'enrich' && sel && <EnrichDialog selection={sel} count={count} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setSelection(emptySelection()); set({ tab: 'enrichment' }); }} />}
      <ConfirmDialog open={dialog === 'archive'} onOpenChange={(o) => !o && setDialog(null)} title={`Archive ${fmtInt(count)} lead(s)`} description="Archived leads are hidden from the repository and distribution. Allocated leads are skipped — revoke them first." requireReason danger confirmLabel="Archive" onConfirm={(reason) => bulk.mutateAsync({ action: 'archive', selection: sel, reason })} />
      <ConfirmDialog open={dialog === 'restore'} onOpenChange={(o) => !o && setDialog(null)} title={`Restore ${fmtInt(count)} lead(s)`} confirmLabel="Restore" onConfirm={() => bulk.mutateAsync({ action: 'restore', selection: sel, reason: 'Restored' })} />
      <TagDialog open={dialog === 'tag'} onClose={() => setDialog(null)} count={count} tags={facets.data?.tags ?? []} onSubmit={(add, remove) => bulk.mutateAsync({ action: 'tag', selection: sel, add, remove })} />
      <ExportDialog open={dialog === 'export'} onClose={() => setDialog(null)} filter={filterObj} view={s.view ?? 'active'} total={total} />
      <CreateLeadDialog open={dialog === 'create'} onClose={() => setDialog(null)} onCreated={(id) => router.push(`/admin/leads/${id}`)} />
      <ReassignDialog open={dialog === 'reassign'} onClose={() => setDialog(null)} selection={sel} count={count} orgs={facets.data?.orgs ?? []} onDone={() => setSelection(emptySelection())} />
      <ConfirmDialog
        open={dialog === 'revoke'} onOpenChange={(o) => !o && setDialog(null)} danger requireReason confirmLabel="Revoke allocations"
        title={`Revoke allocation for ${fmtInt(count)} lead(s)`} description="Allocated leads return to the unallocated pool. The client loses access immediately; their work history is retained but hidden."
        onConfirm={async (reason) => {
          const r = await api<{ revoked: number }>('/api/v1/distribution/revoke', { body: { selection: sel, reason } });
          toast.success(`${r.revoked} allocation(s) revoked`);
          setSelection(emptySelection());
        }}
      />
      <SaveViewDialog open={dialog === 'saveView'} onClose={() => setDialog(null)} state={{ q: s.q ?? '', filter: s.filter ?? '', view: s.view ?? 'active', sort: s.sort ?? '' }} onSaved={() => views.refetch()} />
    </>
  );
}

function TagDialog({ open, onClose, count, tags, onSubmit }: { open: boolean; onClose: () => void; count: number; tags: { id: string; name: string }[]; onSubmit: (add: string[], remove: string[]) => Promise<unknown> }) {
  const [add, setAdd] = useState('');
  const [remove, setRemove] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={`Tag ${fmtInt(count)} lead(s)`} size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { await onSubmit(add.split(',').map((t) => t.trim()).filter(Boolean), remove); setAdd(''); setRemove([]); } finally { setBusy(false); } }}>Apply</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Add tags" hint="Comma-separated. New tags are created automatically."><Input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="priority-q4, webinar" /></Field>
        {tags.length > 0 && (
          <Field label="Remove tags">
            <div className="flex flex-wrap gap-1">{tags.map((t) => (
              <button key={t.id} type="button" onClick={() => setRemove((r) => (r.includes(t.id) ? r.filter((x) => x !== t.id) : [...r, t.id]))} className={`rounded border px-1.5 py-0.5 text-[11px] ${remove.includes(t.id) ? 'border-danger/60 text-danger line-through' : 'border-border-strong text-muted'}`}>{t.name}</button>
            ))}</div>
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function ExportDialog({ open, onClose, filter, view, total }: { open: boolean; onClose: () => void; filter: object; view: string; total: number }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Export leads" description="Administrative export. Requires identity re-verification and is recorded in the audit log." size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={reason.trim().length < 5} onClick={async () => {
        setBusy(true); setError(null);
        try {
          const res = await api<Response>('/api/v1/leads/export', { body: { filter, view, reason }, raw: true });
          const blob = await res.blob();
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `leads-export-${new Date().toISOString().slice(0, 10)}.csv`;
          a.click();
          URL.revokeObjectURL(a.href);
          toast.success('Export generated');
          onClose();
        } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
      }}>Export {fmtInt(total)} rows</Button></>}>
      <div className="flex flex-col gap-3">
        <InlineNotice>The current filters and search apply. Contact fields are included unmasked only if your role can reveal them. Cells are escaped against spreadsheet formula injection.</InlineNotice>
        <Field label="Business reason" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Quarterly reconciliation for finance" /></Field>
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      </div>
    </Dialog>
  );
}

function CreateLeadDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState<Record<string, string>>({});
  const create = useApiMutation((body: Record<string, unknown>) => api<{ id: string }>('/api/v1/leads', { body }), { success: 'Lead created', invalidate: ['/api/v1/leads'], onSuccess: (r) => { setF({}); onClose(); onCreated(r.id); } });
  const field = (k: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <Field label={label}><Input value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} /></Field>
  );
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Add lead" description="Manually create a master lead record." size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!f.fullName?.trim()} onClick={() => {
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(f)) if (v.trim()) body[k] = k === 'score' ? Number(v) : v.trim();
        create.mutate(body);
      }}>Create</Button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {field('fullName', 'Full name *')}{field('company', 'Company')}{field('email', 'Email', { type: 'email' })}{field('phone', 'Phone')}
        {field('jobTitle', 'Job title')}{field('industry', 'Industry')}{field('city', 'City')}{field('country', 'Country')}
        {field('source', 'Source')}{field('campaign', 'Campaign')}{field('score', 'Score (0–100)', { type: 'number', min: 0, max: 100 })}
        <Field label="Priority"><Select value={f.priority ?? 'MEDIUM'} onChange={(e) => setF({ ...f, priority: e.target.value })}>{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => <option key={p}>{p}</option>)}</Select></Field>
      </div>
    </Dialog>
  );
}

function ReassignDialog({ open, onClose, selection, count, orgs, onDone }: { open: boolean; onClose: () => void; selection: Selection | null; count: number; orgs: { id: string; name: string }[]; onDone: () => void }) {
  const [org, setOrg] = useState('');
  return (
    <ConfirmDialog open={open} onOpenChange={(o) => !o && onClose()} title={`Reassign ${fmtInt(count)} lead(s)`} requireReason confirmLabel="Reassign"
      description="Only currently allocated leads are reassigned. The previous client loses access; quotas of the new client apply."
      onConfirm={async (reason) => {
        if (!org) throw new Error('Choose a target organization');
        const r = await api<{ batch: { code: string } }>('/api/v1/distribution/reassign', { body: { selection, toOrganizationId: org, reason, idempotencyKey: crypto.randomUUID() } });
        toast.success(`Reassignment ${r.batch.code} queued`);
        onDone();
      }}>
      <Field label="New organization"><Select value={org} onChange={(e) => setOrg(e.target.value)}><option value="">Select…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
    </ConfirmDialog>
  );
}

function SaveViewDialog({ open, onClose, state, onSaved }: { open: boolean; onClose: () => void; state: Record<string, string>; onSaved: () => void }) {
  const [name, setName] = useState('');
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Save view" size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={async () => {
      try { await api('/api/v1/views', { body: { scope: 'ADMIN_LEADS', name: name.trim(), state } }); toast.success('View saved'); onSaved(); onClose(); setName(''); } catch (e) { toast.error(errorMessage(e)); }
    }}>Save</Button></>}>
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Unallocated US real estate" autoFocus /></Field>
    </Dialog>
  );
}

export { Popover, PopoverContent, PopoverTrigger };
