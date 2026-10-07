'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Timeline } from '@/components/data/timeline';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, DefinitionList } from '@/components/ui/card';
import { Field, Select, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { api, errorMessage } from '@/lib/api-client';
import { fmtAgo, fmtDateTime, humanize } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';

type D = {
  alert: { id: string; type: string; severity: string; status: string; title: string; details: Record<string, unknown>; ip: string | null; createdAt: string; resolvedAt: string | null; resolutionNote: string | null; notes: { id: string; body: string; createdAt: string; authorName: string }[] };
  user: { id: string; name: string; email: string; status: string } | null;
  org: { id: string; name: string; code: string } | null;
  assignee: { id: string; name: string } | null;
  related: { id: string; seq: string; action: string; result: string; createdAt: string; ip: string | null; actorEmail: string | null }[];
  logins: { id: string; success: boolean; reason: string | null; ip: string | null; createdAt: string; email: string }[];
};

export function AlertDetail({ id, canManage, selfId, canUsers }: { id: string; canManage: boolean; selfId: string; canUsers: boolean }) {
  const { data, error, isLoading } = useApiQuery<D>(`/api/v1/security/alerts/${id}`);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [resolution, setResolution] = useState('');
  const update = useApiMutation((b: object) => api(`/api/v1/security/alerts/${id}`, { method: 'PATCH', body: b }), { success: 'Alert updated', invalidate: ['/api/v1/security'], onSuccess: () => { setNote(''); setResolution(''); setStatus(''); } });
  if (error) return <ErrorState description={errorMessage(error)} />;
  if (isLoading || !data) return <Skeleton className="h-96" />;
  const a = data.alert;
  const closing = status === 'RESOLVED' || status === 'DISMISSED';
  return (
    <>
      <PageHeader crumbs={[{ label: 'Security center', href: '/admin/security' }, { label: 'Alert' }]} title={<span className="flex items-center gap-3">{a.title}<StatusBadge status={a.severity} /><StatusBadge status={a.status} /></span>} description={`${humanize(a.type)} · raised ${fmtDateTime(a.createdAt)}`}
        actions={canManage && a.status === 'OPEN' && <Button onClick={() => update.mutate({ status: 'INVESTIGATING', assigneeId: selfId })}>Take ownership</Button>} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-4">
          <Card><CardHeader title="Details" /><CardBody>
            <DefinitionList items={[
              ['User', data.user ? (canUsers ? <Link key="u" className="underline" href={`/admin/users/${data.user.id}`}>{data.user.name} · {data.user.email}</Link> : data.user.email) : '—'],
              ['Organization', data.org ? <Link key="o" className="underline" href={`/admin/organizations/${data.org.id}`}>{data.org.name}</Link> : '—'],
              ['IP', a.ip], ['Assignee', data.assignee?.name ?? 'Unassigned'], ['Resolved', a.resolvedAt ? `${fmtDateTime(a.resolvedAt)} — ${a.resolutionNote}` : '—'],
              ...Object.entries(a.details ?? {}).map(([k, v]) => [humanize(k), typeof v === 'object' ? JSON.stringify(v) : String(v)] as [string, string]),
            ]} />
          </CardBody></Card>
          <Card><CardHeader title="Related activity (±3 days)" description="Events by the same user or from the same IP" />
            <SimpleTable rows={data.related} columns={[
              { key: 'seq', header: '#', render: (r) => <span className="font-mono text-[11px] text-subtle">{r.seq}</span> },
              { key: 'action', header: 'Action', render: (r) => <span className="font-mono text-[11.5px]">{r.action}</span> },
              { key: 'actor', header: 'Actor', render: (r) => r.actorEmail ?? 'System' },
              { key: 'result', header: 'Result', render: (r) => <StatusBadge status={r.result} /> },
              { key: 'ip', header: 'IP', render: (r) => <span className="font-mono text-[11px]">{r.ip ?? '—'}</span> },
              { key: 'at', header: 'When', render: (r) => <span className="text-subtle">{fmtDateTime(r.createdAt)}</span> },
            ]} />
          </Card>
          <Card><CardHeader title="Sign-in attempts (±3 days)" />
            <SimpleTable rows={data.logins} columns={[
              { key: 'email', header: 'Email' }, { key: 'success', header: 'Result', render: (r) => <StatusBadge status={r.success ? 'SUCCESS' : 'FAILURE'} /> },
              { key: 'reason', header: 'Detail', render: (r) => <span className="text-muted">{r.reason?.replace(/_/g, ' ')}</span> },
              { key: 'ip', header: 'IP', render: (r) => <span className="font-mono text-[11px]">{r.ip}</span> }, { key: 'at', header: 'When', render: (r) => <span className="text-subtle">{fmtAgo(r.createdAt)}</span> },
            ]} />
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card><CardHeader title="Investigation log" /><CardBody>
            <Timeline items={a.notes.map((n) => ({ id: n.id, title: n.body, at: n.createdAt, actor: n.authorName }))} empty="No notes yet" />
          </CardBody></Card>
          {canManage && (
            <Card><CardHeader title="Update" /><CardBody className="flex flex-col gap-3">
              <Field label="Add note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Findings, actions taken…" /></Field>
              <Field label="Change status"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Keep {a.status.toLowerCase()}</option>{['OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'].filter((s) => s !== a.status).map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
              {closing && <Field label="Resolution"><Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="Outcome and justification" /></Field>}
              <Button variant="primary" loading={update.isPending} disabled={!note.trim() && !status} onClick={() => update.mutate({ note: note || undefined, status: status || undefined, resolutionNote: resolution || undefined })}>Save</Button>
            </CardBody></Card>
          )}
        </div>
      </div>
    </>
  );
}
