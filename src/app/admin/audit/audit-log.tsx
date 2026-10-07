'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { Download, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/data/data-table';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DefinitionList } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, Drawer } from '@/components/ui/overlay';
import { InlineNotice } from '@/components/ui/states';
import { api, errorMessage, qs } from '@/lib/api-client';
import { fmtDateTime } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';

type Ev = { id: string; seq: string; action: string; actorEmail: string | null; actorRole: string | null; organizationId: string | null; organizationName: string | null; targetType: string | null; targetId: string | null; result: string; reason: string | null; before: unknown; after: unknown; metadata: unknown; requestId: string | null; sessionId: string | null; ip: string | null; userAgent: string | null; hash: string | null; prevHash: string | null; createdAt: string };

export function AuditLog({ canExport, canVerify }: { canExport: boolean; canVerify: boolean }) {
  const [s, set] = useUrlState({ q: '', action: '', actor: '', organizationId: '', result: '', from: '', to: '', page: '1' });
  const orgs = useApiQuery<{ rows: { id: string; name: string }[] }>('/api/v1/organizations?pageSize=200');
  const filter = { q: s.q, action: s.action, actor: s.actor, organizationId: s.organizationId, result: s.result, from: s.from, to: s.to ? `${s.to}T23:59:59Z` : '' };
  const { data, isFetching, error } = useApiQuery<{ total: number; rows: Ev[] }>(`/api/v1/audit${qs({ ...filter, page: s.page, pageSize: 50 })}`);
  const [open, setOpen] = useState<Ev | null>(null);
  const [exp, setExp] = useState(false);
  const [verify, setVerify] = useState<{ checked: number; intact: boolean; firstBrokenSeq: string | null } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const columns: ColumnDef<Ev, unknown>[] = [
    { id: 'seq', header: '#', cell: ({ row: { original: e } }) => <span className="tnum font-mono text-[11px] text-subtle">{e.seq}</span> },
    { id: 'at', header: 'Time', cell: ({ row: { original: e } }) => <span className="text-muted">{fmtDateTime(e.createdAt)}</span> },
    { id: 'action', header: 'Action', cell: ({ row: { original: e } }) => <span className="font-mono text-[11.5px] text-fg">{e.action}</span> },
    { id: 'actor', header: 'Actor', cell: ({ row: { original: e } }) => <div><div>{e.actorEmail ?? 'System'}</div><div className="text-[10.5px] text-subtle">{e.actorRole}</div></div> },
    { id: 'tenant', header: 'Tenant', cell: ({ row: { original: e } }) => <span className="text-muted">{e.organizationName ?? 'Platform'}</span> },
    { id: 'target', header: 'Target', cell: ({ row: { original: e } }) => <span className="text-muted">{e.targetType ?? '—'}{e.targetId && <span className="ml-1 font-mono text-[10.5px] text-subtle">{e.targetId.slice(0, 10)}</span>}</span> },
    { id: 'result', header: 'Result', cell: ({ row: { original: e } }) => <StatusBadge status={e.result} /> },
  ];

  return (
    <>
      <DataTable
        columns={columns} data={data?.rows ?? []} total={data?.total ?? 0} page={Number(s.page)} pageSize={50} onPage={(p) => set({ page: String(p) })} loading={isFetching} error={error ? errorMessage(error) : null}
        getRowId={(r) => r.id} onRowClick={setOpen} dense
        toolbar={
          <div className="flex w-full flex-wrap items-center gap-1.5">
            <Input className="h-7 w-48" placeholder="Search…" defaultValue={s.q} onChange={(e) => set({ q: e.target.value, page: '1' })} aria-label="Search" />
            <Input className="h-7 w-40" placeholder="Action prefix" defaultValue={s.action} onChange={(e) => set({ action: e.target.value, page: '1' })} aria-label="Action" />
            <Input className="h-7 w-44" placeholder="Actor email" defaultValue={s.actor} onChange={(e) => set({ actor: e.target.value, page: '1' })} aria-label="Actor" />
            <Select className="h-7 w-44" value={s.organizationId} onChange={(e) => set({ organizationId: e.target.value, page: '1' })} aria-label="Tenant"><option value="">All tenants</option><option value="platform">Platform only</option>{orgs.data?.rows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
            <Select className="h-7 w-32" value={s.result} onChange={(e) => set({ result: e.target.value, page: '1' })} aria-label="Result"><option value="">Any result</option><option>SUCCESS</option><option>DENIED</option><option>FAILURE</option></Select>
            <Input type="date" className="h-7 w-36" value={s.from} onChange={(e) => set({ from: e.target.value, page: '1' })} aria-label="From" />
            <Input type="date" className="h-7 w-36" value={s.to} onChange={(e) => set({ to: e.target.value, page: '1' })} aria-label="To" />
            <div className="ml-auto flex gap-1.5">
              {canVerify && <Button size="sm" loading={verifying} onClick={async () => { setVerifying(true); try { setVerify(await api('/api/v1/audit/verify', { method: 'POST' })); } catch (e) { toast.error(errorMessage(e)); } finally { setVerifying(false); } }}><ShieldCheck /> Verify integrity</Button>}
              {canExport && <Button size="sm" onClick={() => setExp(true)}><Download /> Export</Button>}
            </div>
          </div>
        }
      />
      {verify && <InlineNotice tone={verify.intact ? 'neutral' : 'danger'} className="mt-3">{verify.intact ? `Hash chain intact across ${verify.checked.toLocaleString()} events.` : `Chain broken at event #${verify.firstBrokenSeq} — investigate immediately.`}</InlineNotice>}
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open?.action} description={open ? `Event #${open.seq} · ${fmtDateTime(open.createdAt)}` : ''} width="lg">
        {open && (
          <div className="flex flex-col gap-4">
            <DefinitionList items={[
              ['Result', <StatusBadge key="r" status={open.result} />], ['Actor', `${open.actorEmail ?? 'System'}${open.actorRole ? ` (${open.actorRole})` : ''}`], ['Tenant', open.organizationName ?? 'Platform'],
              ['Target', `${open.targetType ?? '—'} ${open.targetId ?? ''}`], ['Reason', open.reason], ['IP', open.ip], ['User agent', open.userAgent], ['Request ID', <span key="q" className="font-mono text-[11px]">{open.requestId}</span>],
              ['Session', <span key="s" className="font-mono text-[11px]">{open.sessionId}</span>], ['Hash', <span key="h" className="font-mono text-[10.5px] break-all">{open.hash}</span>], ['Previous hash', <span key="p" className="font-mono text-[10.5px] break-all">{open.prevHash ?? '—'}</span>],
            ]} />
            {(['before', 'after', 'metadata'] as const).map((k) => open[k] != null && (
              <div key={k}><div className="eyebrow mb-1.5">{k}</div><pre className="max-h-64 overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-fg-2">{JSON.stringify(open[k], null, 2)}</pre></div>
            ))}
          </div>
        )}
      </Drawer>
      <ExportAudit open={exp} onClose={() => setExp(false)} filter={filter} total={data?.total ?? 0} />
    </>
  );
}

function ExportAudit({ open, onClose, filter, total }: { open: boolean; onClose: () => void; filter: Record<string, string>; total: number }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const clean = Object.fromEntries(Object.entries(filter).filter(([, v]) => v));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Export audit events" description="Requires re-verification. The export itself is recorded." size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={reason.trim().length < 5} onClick={async () => {
        setBusy(true);
        try {
          const res = await api<Response>('/api/v1/audit/export', { body: { filter: clean, reason }, raw: true });
          const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
          onClose();
        } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
      }}>Export {total.toLocaleString()} events</Button></>}>
      <Field label="Reason"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Incident INC-2041 investigation" /></Field>
    </Dialog>
  );
}
