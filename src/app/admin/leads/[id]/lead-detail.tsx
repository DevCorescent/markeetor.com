'use client';
import { LeadResearchCard } from '../enrichment-panel';
import { Archive, Mail, Pencil, RotateCcw, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { RevealField } from '@/components/data/reveal-field';
import { Timeline } from '@/components/data/timeline';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, DefinitionList } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select } from '@/components/ui/input';
import { Drawer } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { api, errorMessage } from '@/lib/api-client';
import { fmtDate, fmtDateTime, humanize } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';

type Detail = {
  lead: Record<string, any> & { tags: { id: string; name: string }[]; assignments: any[]; importBatch: { id: string; code: string; fileName: string } | null };
  activities: { id: string; type: string; summary: string; verification: any; createdAt: string; actorName: string; organizationName: string | null }[];
  duplicates: { id: string; fullName: string; company: string | null; allocationStatus: string; createdAt: string; archivedAt: string | null }[];
  projections: { id: string; organizationId: string; status: string; revokedAt: string | null; firstContactAt: string | null; lastActivityAt: string | null }[];
};

export function LeadDetail({ id, perms }: { id: string; perms: { reveal: boolean; update: boolean; merge: boolean; archive: boolean; reassign: boolean; email: boolean; enrich: boolean } }) {
  const { data, error, isLoading, refetch } = useApiQuery<Detail>(`/api/v1/leads/${id}`);
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState<null | 'archive' | 'restore' | 'revoke' | 'merge'>(null);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const bulk = useApiMutation((b: object) => api('/api/v1/leads/bulk', { body: b }), { success: 'Updated', invalidate: ['/api/v1/leads'] });

  if (error) return <ErrorState description={errorMessage(error)} action={<Link href="/admin/leads" className="text-xs underline">Back to repository</Link>} />;
  if (isLoading || !data) return <div className="flex flex-col gap-4"><Skeleton className="h-16" /><Skeleton className="h-80" /></div>;
  const l = data.lead;
  const active = l.assignments.find((a: any) => a.status === 'ACTIVE');
  const endpoint = `/api/v1/leads/${id}/reveal`;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Lead repository', href: '/admin/leads' }, { label: l.fullName }]}
        title={<span className="flex items-center gap-3">{l.fullName}<StatusBadge status={l.allocationStatus} />{l.quality === 'INVALID' && <Badge tone="danger">Invalid</Badge>}{l.archivedAt && <Badge tone="dim">Archived</Badge>}</span>}
        description={[l.jobTitle, l.company].filter(Boolean).join(' · ') || undefined}
        actions={
          <>
            {perms.reassign && active && <Button variant="ghost" onClick={() => setConfirm('revoke')}><RotateCcw /> Revoke allocation</Button>}
            {perms.archive && !l.archivedAt && <Button variant="ghost" onClick={() => setConfirm('archive')}><Archive /> Archive</Button>}
            {perms.archive && l.archivedAt && !l.mergedIntoId && <Button variant="ghost" onClick={() => setConfirm('restore')}><Undo2 /> Restore</Button>}
            {perms.email && l.hasEmail && !l.archivedAt && <Link href={`/admin/email/compose?lead=${id}&name=${encodeURIComponent(l.fullName)}`}><Button><Mail /> Send email</Button></Link>}
            {perms.update && <Button onClick={() => setEdit(true)}><Pencil /> Edit</Button>}
          </>
        }
      />
      {l.mergedIntoId && <div className="mb-4 text-xs text-muted">This record was merged into <Link className="underline" href={`/admin/leads/${l.mergedIntoId}`}>another lead</Link>.</div>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Contact & profile" />
            <CardBody className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <DefinitionList items={[
                ['Email', <RevealField key="e" masked={l.email} has={l.hasEmail} endpoint={endpoint} field="email" canReveal={perms.reveal} />],
                ['Phone', <RevealField key="p" masked={l.phone} has={l.hasPhone} endpoint={endpoint} field="phone" canReveal={perms.reveal} />],
                ['Secondary phone', <RevealField key="s" masked={l.secondaryPhone} has={l.hasSecondaryPhone} endpoint={endpoint} field="secondaryPhone" canReveal={perms.reveal} />],
                ['Company', l.company], ['Job title', l.jobTitle], ['Location', [l.city, l.state, l.country].filter(Boolean).join(', ') || null], ['Industry', l.industry],
              ]} />
              <DefinitionList items={[
                ['Source', l.source], ['Campaign', l.campaign], ['Score', <span key="sc" className="tnum">{l.score}</span>], ['Priority', <StatusBadge key="pr" status={l.priority} />],
                ['Import batch', l.importBatch ? <Link key="ib" className="underline" href={`/admin/imports/${l.importBatch.id}`}>{l.importBatch.code}</Link> : 'Manual'],
                ['Created', fmtDateTime(l.createdAt)], ['Last activity', fmtDateTime(l.lastActivityAt)],
              ]} />
              {l.qualityIssues?.length > 0 && <div className="md:col-span-2 text-xs text-warn">Quality issues: {l.qualityIssues.join('; ')}</div>}
              {Object.keys(l.customFields ?? {}).length > 0 && (
                <div className="md:col-span-2"><div className="eyebrow mb-2">Custom fields</div><DefinitionList items={Object.entries(l.customFields).map(([k, v]) => [humanize(k), String(v ?? '—')])} /></div>
              )}
              <div className="md:col-span-2 flex flex-wrap gap-1">{l.tags.map((t) => <Badge key={t.id} tone="outline">{t.name}</Badge>)}{!l.tags.length && <span className="text-xs text-subtle">No tags</span>}</div>
            </CardBody>
          </Card>
          <LeadResearchCard leadId={id} canRun={perms.enrich} onApplied={() => refetch()} />
          <Card>
            <CardHeader title="Assignment history" description="Every allocation of this lead, including revoked and rolled-back ones" />
            <SimpleTable
              rows={l.assignments}
              empty={<div className="py-6 text-center text-xs text-subtle">Never allocated</div>}
              columns={[
                { key: 'org', header: 'Organization', render: (a) => <Link className="hover:underline" href={`/admin/organizations/${a.organization.id}`}>{a.organization.name}</Link> },
                { key: 'status', header: 'Status', render: (a) => <StatusBadge status={a.status} /> },
                { key: 'batch', header: 'Batch', render: (a) => (a.batch ? <Link className="font-mono text-[11.5px] hover:underline" href={`/admin/distribution/batches/${a.batch.id}`}>{a.batch.code}</Link> : '—') },
                { key: 'assignedAt', header: 'Assigned', render: (a) => fmtDateTime(a.assignedAt) },
                { key: 'endedAt', header: 'Ended', render: (a) => (a.endedAt ? <span title={a.endedReason ?? ''}>{fmtDateTime(a.endedAt)}</span> : '—') },
              ]}
            />
          </Card>
          <Card>
            <CardHeader title="Lifecycle timeline" description="Platform and client events. Hollow markers are self-reported by users." />
            <CardBody>
              <Timeline items={data.activities.map((a) => ({ id: a.id, title: `${humanize(a.type)} — ${a.summary}`, at: a.createdAt, actor: `${a.actorName}${a.organizationName ? ` · ${a.organizationName}` : ''}`, verification: a.verification }))} />
            </CardBody>
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Current client progress" />
            <CardBody>
              {active ? (
                <DefinitionList items={[
                  ['Client', active.organization.name], ['Client status', l.clientStatus ? <StatusBadge key="cs" status={l.clientStatus} /> : '—'],
                  ['Allocated', fmtDate(active.assignedAt)],
                  ['First contact', fmtDateTime(data.projections.find((p) => !p.revokedAt)?.firstContactAt)],
                  ['Next follow-up', fmtDateTime(l.nextFollowUpAt)],
                ]} />
              ) : <p className="text-xs text-subtle">Not currently allocated.</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Possible duplicates" description="Same normalized email or phone" actions={perms.merge && data.duplicates.length > 0 ? <Button size="sm" disabled={!mergeIds.length} onClick={() => setConfirm('merge')}>Merge {mergeIds.length || ''}</Button> : null} />
            <ul>
              {data.duplicates.length === 0 && <li className="px-4 py-5 text-xs text-subtle">None found</li>}
              {data.duplicates.map((d) => (
                <li key={d.id} className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-[12.5px] last:border-0">
                  {perms.merge && !d.archivedAt && <input type="checkbox" aria-label={`Select ${d.fullName}`} checked={mergeIds.includes(d.id)} onChange={(e) => setMergeIds((m) => (e.target.checked ? [...m, d.id] : m.filter((x) => x !== d.id)))} className="accent-white" />}
                  <Link className="min-w-0 flex-1 truncate hover:underline" href={`/admin/leads/${d.id}`}>{d.fullName}<span className="text-subtle"> · {d.company ?? '—'}</span></Link>
                  <StatusBadge status={d.archivedAt ? 'ARCHIVED' : d.allocationStatus} />
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <EditLeadDrawer open={edit} onClose={() => setEdit(false)} lead={l} id={id} />
      <ConfirmDialog open={confirm === 'archive'} onOpenChange={(o) => !o && setConfirm(null)} title="Archive lead" danger requireReason confirmLabel="Archive" onConfirm={(reason) => bulk.mutateAsync({ action: 'archive', selection: { mode: 'ids', ids: [id] }, reason })} />
      <ConfirmDialog open={confirm === 'restore'} onOpenChange={(o) => !o && setConfirm(null)} title="Restore lead" confirmLabel="Restore" onConfirm={() => bulk.mutateAsync({ action: 'restore', selection: { mode: 'ids', ids: [id] }, reason: 'Restored' })} />
      <ConfirmDialog open={confirm === 'revoke'} onOpenChange={(o) => !o && setConfirm(null)} title="Revoke allocation" danger requireReason confirmLabel="Revoke"
        description={`${active?.organization?.name ?? 'The client'} will lose access immediately. Their notes and activity are retained but hidden.`}
        onConfirm={async (reason) => { await api('/api/v1/distribution/revoke', { body: { selection: { mode: 'ids', ids: [id] }, reason } }); toast.success('Allocation revoked'); location.reload(); }} />
      <ConfirmDialog open={confirm === 'merge'} onOpenChange={(o) => !o && setConfirm(null)} title={`Merge ${mergeIds.length} duplicate(s) into this lead`} requireReason confirmLabel="Merge"
        onConfirm={async (reason) => { await api('/api/v1/leads/merge', { body: { primaryId: id, duplicateIds: mergeIds, reason } }); toast.success('Merged'); location.reload(); }} />
    </>
  );
}

function EditLeadDrawer({ open, onClose, lead, id }: { open: boolean; onClose: () => void; lead: Record<string, any>; id: string }) {
  const keys = ['fullName', 'company', 'jobTitle', 'city', 'state', 'country', 'industry', 'source', 'campaign'] as const;
  const [f, setF] = useState<Record<string, string>>({});
  const save = useApiMutation((b: object) => api(`/api/v1/leads/${id}`, { method: 'PATCH', body: b }), { success: 'Lead updated', invalidate: [`/api/v1/leads/${id}`], onSuccess: onClose });
  const val = (k: string) => f[k] ?? lead[k] ?? '';
  return (
    <Drawer open={open} onOpenChange={(o) => { if (!o) { onClose(); setF({}); } }} title="Edit lead" description="Changes are recorded with before/after values in the audit log. Contact fields are replaced only if you type a new value."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => {
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(f)) body[k] = k === 'score' ? Number(v) : v.trim() === '' && k !== 'fullName' ? null : v.trim();
        save.mutate(body);
      }}>Save changes</Button></>}>
      <div className="grid gap-3">
        {keys.map((k) => <Field key={k} label={humanize(k)}><Input value={val(k)} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
        <Field label="New email (optional)"><Input type="email" value={f.email ?? ''} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="Leave blank to keep current" /></Field>
        <Field label="New phone (optional)"><Input value={f.phone ?? ''} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="Leave blank to keep current" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Score"><Input type="number" min={0} max={100} value={val('score')} onChange={(e) => setF({ ...f, score: e.target.value })} /></Field>
          <Field label="Priority"><Select value={val('priority')} onChange={(e) => setF({ ...f, priority: e.target.value })}>{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => <option key={p}>{p}</option>)}</Select></Field>
        </div>
      </div>
    </Drawer>
  );
}
