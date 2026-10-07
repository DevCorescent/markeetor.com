'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { Copy, Plus, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Meter } from '@/components/data/charts';
import { DataTable } from '@/components/data/data-table';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { InlineNotice } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { fmtDate, fmtInt } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';

type Org = { id: string; code: string; name: string; industry: string | null; status: string; createdAt: string; users: number; activeLeads: number; converted: number; maxActiveLeads: number; capacityPaused: boolean };

const columns: ColumnDef<Org, unknown>[] = [
  { id: 'name', header: 'Organization', cell: ({ row: { original: o } }) => <div><div className="text-fg">{o.name}</div><div className="font-mono text-[11px] text-subtle">{o.code}</div></div> },
  { id: 'industry', header: 'Industry', cell: ({ row: { original: o } }) => o.industry ?? '—' },
  { id: 'status', header: 'Status', cell: ({ row: { original: o } }) => <span className="flex gap-1.5"><StatusBadge status={o.status} />{o.capacityPaused && <span className="text-[11px] text-warn">paused</span>}</span> },
  { id: 'users', header: 'Users', cell: ({ row: { original: o } }) => <span className="tnum">{o.users}</span> },
  { id: 'active', header: 'Active leads', cell: ({ row: { original: o } }) => <span className="tnum">{fmtInt(o.activeLeads)}</span> },
  { id: 'cap', header: 'Capacity', cell: ({ row: { original: o } }) => <Meter value={o.maxActiveLeads ? o.activeLeads / o.maxActiveLeads : null} /> },
  { id: 'converted', header: 'Converted', cell: ({ row: { original: o } }) => <span className="tnum">{fmtInt(o.converted)}</span> },
  { id: 'created', header: 'Created', cell: ({ row: { original: o } }) => <span className="text-subtle">{fmtDate(o.createdAt)}</span> },
];

export function OrgList({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [s, set] = useUrlState({ q: '', status: '', page: '1' });
  const { data, isFetching, error } = useApiQuery<{ total: number; rows: Org[] }>(`/api/v1/organizations?page=${s.page}&pageSize=25${s.q ? `&q=${encodeURIComponent(s.q)}` : ''}${s.status ? `&status=${s.status}` : ''}`);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Client organizations" description="Provision workspaces, set quotas and features, and control access." actions={canCreate && <Button variant="primary" onClick={() => setOpen(true)}><Plus /> New organization</Button>} />
      <DataTable
        columns={columns} data={data?.rows ?? []} total={data?.total ?? 0} page={Number(s.page)} pageSize={25} onPage={(p) => set({ page: String(p) })} loading={isFetching} error={error ? errorMessage(error) : null}
        getRowId={(r) => r.id} onRowClick={(r) => router.push(`/admin/organizations/${r.id}`)}
        toolbar={
          <>
            <div className="relative w-64"><Search className="absolute top-2 left-2.5 size-3.5 text-subtle" /><Input className="pl-8" placeholder="Search name or code" defaultValue={s.q} onChange={(e) => set({ q: e.target.value, page: '1' })} /></div>
            <div className="flex items-center rounded-md border border-border bg-surface p-0.5">
              {['', 'ACTIVE', 'INACTIVE', 'SUSPENDED', 'ARCHIVED'].map((st) => (
                <button key={st} onClick={() => set({ status: st, page: '1' })} className={`h-6 rounded px-2 text-[11.5px] ${s.status === st ? 'bg-fg text-inverse' : 'text-muted hover:text-fg'}`}>{st ? st[0] + st.slice(1).toLowerCase() : 'All'}</button>
              ))}
            </div>
          </>
        }
      />
      <CreateOrgDialog open={open} onClose={() => setOpen(false)} onCreated={(id) => router.push(`/admin/organizations/${id}`)} />
    </>
  );
}

function CreateOrgDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ name: '', industry: '', contactEmail: '', website: '', ownerName: '', ownerEmail: '', maxActiveLeads: '2000', dailyAllocationLimit: '500' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; invite: { inviteUrl: string; email: string } | null } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ org: { id: string }; invite: { inviteUrl: string; email: string } | null }>('/api/v1/organizations', {
        body: {
          name: f.name, industry: f.industry || null, contactEmail: f.contactEmail || null, website: f.website || null,
          owner: f.ownerEmail ? { name: f.ownerName || f.ownerEmail.split('@')[0], email: f.ownerEmail } : undefined,
          quota: { maxActiveLeads: Number(f.maxActiveLeads), dailyAllocationLimit: Number(f.dailyAllocationLimit) },
        },
      });
      setCreated({ id: res.org.id, invite: res.invite });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => { setCreated(null); setF({ name: '', industry: '', contactEmail: '', website: '', ownerName: '', ownerEmail: '', maxActiveLeads: '2000', dailyAllocationLimit: '500' }); onClose(); };
  if (created) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && close()} title="Organization created" size="md" footer={<Button variant="primary" onClick={() => onCreated(created.id)}>Open workspace settings</Button>}>
        <div className="flex flex-col gap-3 text-[12.5px]">
          <p className="text-muted">A unique organization ID was generated and the workspace was provisioned with a default sales pipeline.</p>
          {created.invite && (
            <>
              <InlineNotice>An invitation was sent to {created.invite.email}. If email delivery isn’t configured, share this single-use link securely — it expires in 7 days and is not shown again.</InlineNotice>
              <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded border border-border-strong bg-surface-2 px-2 py-1.5 font-mono text-[11px]">{created.invite.inviteUrl}</code><Button size="sm" onClick={() => { navigator.clipboard.writeText(created.invite!.inviteUrl); toast.success('Copied'); }}><Copy /> Copy</Button></div>
            </>
          )}
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="New client organization" description="Creates an isolated workspace. Features, security and allocation profile can be configured next." size="lg"
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={f.name.trim().length < 2} onClick={submit}>Create organization</Button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Organization name" required><Input value={f.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Industry"><Input value={f.industry} onChange={set('industry')} /></Field>
        <Field label="Contact email"><Input type="email" value={f.contactEmail} onChange={set('contactEmail')} /></Field>
        <Field label="Website"><Input value={f.website} onChange={set('website')} placeholder="https://" /></Field>
        <div className="sm:col-span-2 mt-2 eyebrow">Owner account (optional)</div>
        <Field label="Owner name"><Input value={f.ownerName} onChange={set('ownerName')} /></Field>
        <Field label="Owner email" hint="Receives a secure invitation to set their password"><Input type="email" value={f.ownerEmail} onChange={set('ownerEmail')} /></Field>
        <div className="sm:col-span-2 mt-2 eyebrow">Initial quotas</div>
        <Field label="Max active leads"><Input type="number" min={0} value={f.maxActiveLeads} onChange={set('maxActiveLeads')} /></Field>
        <Field label="Daily allocation limit"><Input type="number" min={0} value={f.dailyAllocationLimit} onChange={set('dailyAllocationLimit')} /></Field>
        {error && <InlineNotice tone="danger" className="sm:col-span-2">{error}</InlineNotice>}
      </div>
    </Dialog>
  );
}
