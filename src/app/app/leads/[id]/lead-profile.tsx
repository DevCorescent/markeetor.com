'use client';
import { CompanyCard } from './company-card';
import { LeadMarketing } from '@/components/marketing/lead-marketing';
import { AssistantCard, ContactNow, ReportProblem } from './lead-power';
import { Archive, CalendarPlus, Check, FileText, Mail, MessageSquare, Paperclip, Phone, Pin, Trash2, Undo2, Users } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { RevealField } from '@/components/data/reveal-field';
import { Timeline } from '@/components/data/timeline';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, DefinitionList } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Checkbox, Dialog, Drawer, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { ErrorState, InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { fmtAgo, fmtDate, fmtDateTime, fmtMoney, humanize } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import type { ClientFacets } from '../client-leads';

type Perms = { update: boolean; reveal: boolean; assign: boolean; notes: boolean; comms: boolean; tasks: boolean; upload: boolean; view: boolean; move: boolean; archive: boolean; merge: boolean; email: boolean; marketing: boolean };
type V = 'SYSTEM_VERIFIED' | 'SELF_REPORTED' | 'PROVIDER_VERIFIED';
type Profile = {
  lead: Record<string, any> & { id: string; fullName: string; status: string; priority: string; dealValue: number | null; currency: string; customFields: Record<string, unknown>; archivedAt: string | null };
  owner: { id: string; name: string } | null;
  stage: { id: string; name: string; category: string } | null;
  tags: { id: string; name: string }[];
  notes: { id: string; body: string; pinned: boolean; createdAt: string; authorName: string; mine: boolean }[];
  tasks: { id: string; title: string; type: string; priority: string; status: string; dueAt: string | null; assigneeName: string | null; completionNote: string | null }[];
  comms: { id: string; channel: string; direction: string; outcome: string; durationSec: number | null; subject: string | null; body: string | null; occurredAt: string; userName: string; verification: V }[];
  attachments: { id: string; fileName: string; mimeType: string; size: number; createdAt: string; uploadedBy: string }[];
  activities: { id: string; type: string; summary: string; verification: V; createdAt: string; actorName: string }[];
  consent: Record<string, string>;
  consents: { id: string; channel: string; status: string; source: string | null; createdAt: string; recordedBy: string }[];
  stageHistory: { id: string; from: string | null; to: string; by: string; durationMs: number | null; createdAt: string }[];
  duplicates: { id: string; fullName: string; company: string | null; status: string }[];
  fields: { key: string; label: string; type: string; options: string[]; required: boolean }[];
};

const STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'NEGOTIATION', 'CONVERTED', 'LOST'];
const OUTCOMES: Record<string, string[]> = {
  CALL: ['CONNECTED', 'NO_ANSWER', 'VOICEMAIL', 'BUSY', 'WRONG_NUMBER'], EMAIL: ['SENT', 'REPLIED', 'BOUNCED'], SMS: ['SENT', 'REPLIED'], WHATSAPP: ['SENT', 'REPLIED'], MEETING: ['HELD', 'NO_SHOW', 'RESCHEDULED'],
};
const LOST_REASONS = ['No budget', 'Chose a competitor', 'Not interested', 'Unresponsive', 'Bad timing', 'Not a fit', 'Duplicate'];
const dur = (ms: number | null) => (ms == null ? '' : ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : ms < 172_800_000 ? `${Math.round(ms / 3600_000)}h` : `${Math.round(ms / 86_400_000)}d`);

export function LeadProfile({ id, selfId, features, revealRequiresReason, perms }: { id: string; selfId: string; features: Record<string, boolean>; revealRequiresReason: boolean; perms: Perms }) {
  const { data, error, isLoading, refetch: refetchLead } = useApiQuery<Profile>(`/api/v1/crm/leads/${id}`);
  const facets = useApiQuery<ClientFacets>('/api/v1/crm/leads/facets');
  const [tab, setTab] = useState('activity');
  const [edit, setEdit] = useState(false);
  const [lost, setLost] = useState<{ kind: 'status' | 'stage'; stageId?: string } | null>(null);
  const [lostReason, setLostReason] = useState(LOST_REASONS[0]);
  const [archive, setArchive] = useState(false);
  const [mergeWith, setMergeWith] = useState<{ id: string; fullName: string } | null>(null);
  const inv = ['/api/v1/crm'];
  const status = useApiMutation((b: { status: string; lostReason?: string }) => api(`/api/v1/crm/leads/${id}/status`, { body: b }), { success: 'Status updated', invalidate: inv });
  const stage = useApiMutation((b: { stageId: string; lostReason?: string }) => api(`/api/v1/crm/leads/${id}/stage`, { body: b }), { success: 'Stage updated', invalidate: inv });
  const owner = useApiMutation((ownerId: string | null) => api('/api/v1/crm/leads/bulk', { body: { action: 'assign', ids: [id], ownerId } }), { success: 'Owner updated', invalidate: inv });
  const arch = useApiMutation((a: boolean) => api('/api/v1/crm/leads/bulk', { body: { action: a ? 'archive' : 'restore', ids: [id] } }), { success: 'Updated', invalidate: inv });

  if (error) return <ErrorState title="Lead unavailable" description={errorMessage(error)} action={<Link href="/app/leads" className="text-xs underline">Back to leads</Link>} />;
  if (isLoading || !data) return <div className="flex flex-col gap-4"><Skeleton className="h-16" /><Skeleton className="h-96" /></div>;
  const l = data.lead;
  const endpoint = `/api/v1/crm/leads/${id}/reveal`;
  const stages = facets.data?.stages ?? [];

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Leads', href: '/app/leads' }, { label: l.fullName }]}
        title={<span className="flex flex-wrap items-center gap-3">{l.fullName}<StatusBadge status={l.status} /><StatusBadge status={l.priority} />{l.archivedAt && <Badge tone="dim">Archived</Badge>}</span>}
        description={[l.jobTitle, l.company, [l.city, l.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
        actions={
          <>
            {perms.archive && <Button variant="ghost" onClick={() => (l.archivedAt ? arch.mutate(false) : setArchive(true))}>{l.archivedAt ? <><Undo2 /> Restore</> : <><Archive /> Archive</>}</Button>}
            {perms.update && <Button onClick={() => setEdit(true)}>Edit details</Button>}
          </>
        }
      />
      {data.duplicates.length > 0 && (
        <InlineNotice tone="warn" className="mb-4">
          Possible duplicate{data.duplicates.length > 1 ? 's' : ''} in your workspace: {data.duplicates.map((d, i) => (
            <span key={d.id}>{i > 0 && ', '}<Link className="underline" href={`/app/leads/${d.id}`}>{d.fullName}</Link>{perms.merge && <button className="ml-1 underline" onClick={() => setMergeWith(d)}>(merge into this)</button>}</span>
          ))}
        </InlineNotice>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Contact" description="Masked by default · reveals are logged" />
            <CardBody>
              <DefinitionList items={[
                ['Email', <span key="e" className="flex items-center gap-1"><Mail className="size-3 text-subtle" /><RevealField masked={l.email} has={l.hasEmail} endpoint={endpoint} field="email" canReveal={perms.reveal} requireReason={revealRequiresReason} /></span>],
                ['Phone', <span key="p" className="flex items-center gap-1"><Phone className="size-3 text-subtle" /><RevealField masked={l.phone} has={l.hasPhone} endpoint={endpoint} field="phone" canReveal={perms.reveal} requireReason={revealRequiresReason} /></span>],
                ['Alt. phone', <RevealField key="s" masked={l.secondaryPhone} has={l.hasSecondaryPhone} endpoint={endpoint} field="secondaryPhone" canReveal={perms.reveal} requireReason={revealRequiresReason} />],
              ]} />
              {Object.keys(data.consent).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">{Object.entries(data.consent).map(([ch, st]) => <Badge key={ch} tone={st === 'OPTED_OUT' ? 'danger' : 'ok'}>{humanize(ch)}: {st === 'OPTED_OUT' ? 'opted out' : 'opted in'}</Badge>)}</div>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Status & ownership" />
            <CardBody className="flex flex-col gap-3">
              <Field label="Status">
                <Select disabled={!perms.update} value={l.status} onChange={(e) => (e.target.value === 'LOST' ? setLost({ kind: 'status' }) : status.mutate({ status: e.target.value }))}>
                  {STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                </Select>
              </Field>
              {features.pipeline && (
                <Field label="Pipeline stage">
                  <Select disabled={!perms.move} value={data.stage?.id ?? ''} onChange={(e) => { const st = stages.find((x) => x.id === e.target.value); if (st?.category === 'LOST') setLost({ kind: 'stage', stageId: st.id }); else stage.mutate({ stageId: e.target.value }); }}>
                    {!data.stage && <option value="">—</option>}
                    {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="Owner">
                <Select disabled={!perms.assign} value={data.owner?.id ?? ''} onChange={(e) => owner.mutate(e.target.value || null)}>
                  <option value="">Unassigned</option>
                  {(facets.data?.members ?? (data.owner ? [{ ...data.owner, role: '' }] : [])).map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === selfId ? ' (you)' : ''}</option>)}
                </Select>
              </Field>
              {l.status === 'LOST' && l.lostReason && <p className="text-xs text-subtle">Lost reason: {l.lostReason}</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Deal" />
            <CardBody>
              <DefinitionList items={[
                ['Value', l.dealValue != null ? fmtMoney(l.dealValue, l.currency) : '—'], ['Probability', l.probability != null ? `${l.probability}%` : '—'],
                ['Expected close', fmtDate(l.expectedCloseDate)], ['Next follow-up', l.nextFollowUpAt ? <span key="f" className={new Date(l.nextFollowUpAt) < new Date() ? 'text-warn' : ''}>{fmtDateTime(l.nextFollowUpAt)}</span> : '—'],
                ['First contact', fmtDateTime(l.firstContactAt)], ['Allocated', fmtDateTime(l.createdAt)],
              ]} />
            </CardBody>
          </Card>
          <CompanyCard leadId={id} onUpdated={() => refetchLead()} />
          <Card>
            <CardHeader title="Attribution" description="Set by the platform · read-only" />
            <CardBody><DefinitionList items={[['Source', l.source], ['Campaign', l.campaign], ['Industry', l.industry], ['Score', l.score]]} /></CardBody>
          </Card>
          {(data.fields.length > 0 || data.tags.length > 0) && (
            <Card>
              <CardHeader title="Custom fields & tags" />
              <CardBody className="flex flex-col gap-3">
                {data.fields.length > 0 && <DefinitionList items={data.fields.map((f) => [f.label, l.customFields?.[f.key] == null ? '—' : String(l.customFields[f.key])])} />}
                <div className="flex flex-wrap gap-1">{data.tags.map((t) => <Badge key={t.id} tone="outline">{t.name}</Badge>)}</div>
              </CardBody>
            </Card>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <QuickActions id={id} perms={perms} features={features} consent={data.consent} name={l.fullName} canEmail={perms.email && l.hasEmail && data.consent.EMAIL !== 'OPTED_OUT'} hasPhone={l.hasPhone} requireReason={revealRequiresReason} />
          <LeadMarketing id={id} consent={data.consent} hasPhone={l.hasPhone} canSend={perms.comms || perms.email} canSequence={perms.marketing} />
          <AssistantCard id={id} />
          <Card>
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="px-3">
                <TabsTrigger value="activity">Timeline</TabsTrigger>
                <TabsTrigger value="notes">Notes ({data.notes.length})</TabsTrigger>
                {features.communication && <TabsTrigger value="comms">Communication ({data.comms.length})</TabsTrigger>}
                {features.tasks && <TabsTrigger value="tasks">Tasks ({data.tasks.filter((t) => t.status !== 'DONE').length})</TabsTrigger>}
                {features.attachments && <TabsTrigger value="files">Files ({data.attachments.length})</TabsTrigger>}
                {features.pipeline && <TabsTrigger value="stages">Stage history</TabsTrigger>}
              </TabsList>
            </Tabs>
            <CardBody>
              {tab === 'activity' && <Timeline items={data.activities.filter((a) => a.type !== 'LEAD_VIEWED').map((a) => ({ id: a.id, title: `${humanize(a.type)} — ${a.summary}`, at: a.createdAt, actor: a.actorName, verification: a.verification }))} />}
              {tab === 'notes' && <NotesTab id={id} notes={data.notes} canWrite={perms.notes} />}
              {tab === 'comms' && <CommsTab comms={data.comms} consents={data.consents} />}
              {tab === 'tasks' && <TasksTab tasks={data.tasks} canManage={perms.tasks} />}
              {tab === 'files' && <FilesTab id={id} files={data.attachments} canUpload={perms.upload} canView={perms.view} />}
              {tab === 'stages' && (
                <Timeline items={data.stageHistory.map((h) => ({ id: h.id, title: `${h.from ?? 'Start'} → ${h.to}`, body: h.durationMs ? `${dur(h.durationMs)} in previous stage` : undefined, at: h.createdAt, actor: h.by, verification: 'SYSTEM_VERIFIED' as const }))} empty="No stage changes yet" />
              )}
            </CardBody>
          </Card>
        </div>
      </div>
      {edit && <EditDrawer lead={l} fields={data.fields} onClose={() => setEdit(false)} />}
      <ConfirmDialog open={!!lost} onOpenChange={(o) => !o && setLost(null)} title="Mark as lost" confirmLabel="Mark lost" danger
        onConfirm={() => (lost?.kind === 'stage' ? stage.mutateAsync({ stageId: lost.stageId!, lostReason }) : status.mutateAsync({ status: 'LOST', lostReason }))}>
        <Field label="Reason"><Select value={lostReason} onChange={(e) => setLostReason(e.target.value)}>{LOST_REASONS.map((r) => <option key={r}>{r}</option>)}</Select></Field>
      </ConfirmDialog>
      <ConfirmDialog open={archive} onOpenChange={setArchive} title="Archive lead" danger confirmLabel="Archive" description="Archived leads are hidden from lists and the pipeline. You can restore them later." onConfirm={() => arch.mutateAsync(true)} />
      <ConfirmDialog open={!!mergeWith} onOpenChange={(o) => !o && setMergeWith(null)} title={`Merge ${mergeWith?.fullName} into ${l.fullName}`} confirmLabel="Merge"
        description="Notes, tasks, communication, files and tags move to this lead. The duplicate is archived. This is recorded in the audit log."
        onConfirm={async () => { await api('/api/v1/crm/leads/merge', { body: { primaryId: id, duplicateId: mergeWith!.id } }); toast.success('Merged'); location.reload(); }} />
    </>
  );
}

function QuickActions({ id, perms, features, consent, name, canEmail, hasPhone, requireReason }: { id: string; perms: Perms; features: Record<string, boolean>; consent: Record<string, string>; name: string; canEmail: boolean; hasPhone: boolean; requireReason: boolean }) {
  const [dlg, setDlg] = useState<null | 'log' | 'task' | 'followup' | 'consent'>(null);
  const [report, setReport] = useState(false);
  const quick = hasPhone && perms.reveal && perms.comms && features.communication;
  return (
    <div className="flex flex-wrap gap-2">
      {quick && <ContactNow id={id} channel="CALL" requireReason={requireReason} consent={consent} onWrongNumber={() => setReport(true)} />}
      {quick && <ContactNow id={id} channel="WHATSAPP" requireReason={requireReason} consent={consent} onWrongNumber={() => setReport(true)} />}
      {canEmail && <Link href={`/app/email/compose?lead=${id}&name=${encodeURIComponent(name)}`}><Button variant="primary"><Mail /> Send email</Button></Link>}
      {perms.comms && features.communication && <Button variant="primary" onClick={() => setDlg('log')}><Phone /> Log contact</Button>}
      {perms.update && <Button onClick={() => setDlg('followup')}><CalendarPlus /> Schedule follow-up</Button>}
      {perms.tasks && features.tasks && <Button onClick={() => setDlg('task')}><Check /> Add task</Button>}
      {perms.comms && <Button variant="ghost" onClick={() => setDlg('consent')}><Users /> Record consent</Button>}
      {perms.update && <ReportProblem id={id} open={report} onOpenChange={setReport} />}
      {dlg === 'log' && <LogDialog id={id} consent={consent} onClose={() => setDlg(null)} />}
      {dlg === 'task' && <TaskDialog id={id} onClose={() => setDlg(null)} />}
      {dlg === 'followup' && <FollowUpDialog id={id} onClose={() => setDlg(null)} />}
      {dlg === 'consent' && <ConsentDialog id={id} onClose={() => setDlg(null)} />}
    </div>
  );
}

function LogDialog({ id, consent, onClose }: { id: string; consent: Record<string, string>; onClose: () => void }) {
  const [f, setF] = useState({ channel: 'CALL', direction: 'OUTBOUND', outcome: 'CONNECTED', durationMin: '', subject: '', body: '', occurredAt: '' });
  const templates = useApiQuery<{ templates: { id: string; name: string; channel: string; subject: string | null; body: string }[] }>('/api/v1/crm/templates');
  const m = useApiMutation(() => api(`/api/v1/crm/leads/${id}/comms`, { body: { channel: f.channel, direction: f.direction, outcome: f.outcome, durationSec: f.durationMin ? Math.round(Number(f.durationMin) * 60) : null, subject: f.subject || null, body: f.body || null, ...(f.occurredAt ? { occurredAt: new Date(f.occurredAt).toISOString() } : {}) } }), { success: 'Contact attempt logged', invalidate: ['/api/v1/crm'], onSuccess: onClose });
  const optedOut = f.direction === 'OUTBOUND' && consent[f.channel] === 'OPTED_OUT';
  const tpl = templates.data?.templates.filter((t) => t.channel === f.channel) ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Log a contact attempt" description="Recorded as self-reported activity. Logging an attempt is not verification that a conversation took place." size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={optedOut} onClick={() => m.mutate(undefined)}>Log</Button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Channel"><Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value, outcome: OUTCOMES[e.target.value][0] })}>{Object.keys(OUTCOMES).map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select></Field>
        <Field label="Direction"><Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="OUTBOUND">Outbound</option><option value="INBOUND">Inbound</option></Select></Field>
        <Field label="Outcome"><Select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>{OUTCOMES[f.channel].map((o) => <option key={o} value={o}>{humanize(o)}</option>)}</Select></Field>
        {(f.channel === 'CALL' || f.channel === 'MEETING') && <Field label="Duration (minutes)"><Input type="number" min={0} value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: e.target.value })} /></Field>}
        <Field label="When" hint="Leave blank for now"><Input type="datetime-local" value={f.occurredAt} max={new Date().toISOString().slice(0, 16)} onChange={(e) => setF({ ...f, occurredAt: e.target.value })} /></Field>
        {tpl.length > 0 && <Field label="Template"><Select defaultValue="" onChange={(e) => { const t = tpl.find((x) => x.id === e.target.value); if (t) setF({ ...f, subject: t.subject ?? '', body: t.body }); }}><option value="">None</option>{tpl.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>}
        {(f.channel === 'EMAIL' || f.channel === 'MEETING') && <Field label="Subject" className="sm:col-span-2"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>}
        <Field label="Notes" className="sm:col-span-2"><Textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="What was discussed, next steps…" /></Field>
        {optedOut && <InlineNotice tone="danger" className="sm:col-span-2">This lead has opted out of {f.channel.toLowerCase()} contact. Outbound attempts on this channel cannot be logged.</InlineNotice>}
        <p className="text-[11px] text-subtle sm:col-span-2">This only logs a contact. To send WhatsApp or SMS from the platform, use the Marketing card.</p>
      </div>
    </Dialog>
  );
}

function TaskDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [f, setF] = useState({ title: '', type: 'CALL', priority: 'MEDIUM', dueAt: '', recurrence: 'NONE' });
  const m = useApiMutation(() => api('/api/v1/crm/tasks', { body: { ...f, clientLeadId: id, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : null } }), { success: 'Task created', invalidate: ['/api/v1/crm'], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add task" size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={f.title.trim().length < 2} onClick={() => m.mutate(undefined)}>Create</Button></>}>
      <div className="grid gap-3">
        <Field label="Title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['CALL', 'MEETING', 'EMAIL', 'FOLLOW_UP', 'TODO'].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
          <Field label="Priority"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
          <Field label="Due"><Input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
          <Field label="Repeats"><Select value={f.recurrence} onChange={(e) => setF({ ...f, recurrence: e.target.value })}>{['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
        </div>
      </div>
    </Dialog>
  );
}

function FollowUpDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [at, setAt] = useState('');
  const m = useApiMutation(() => api(`/api/v1/crm/leads/${id}`, { method: 'PATCH', body: { nextFollowUpAt: new Date(at).toISOString() } }), { success: 'Follow-up scheduled — a task was created', invalidate: ['/api/v1/crm'], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Schedule follow-up" description="Sets the lead’s next follow-up date and creates a follow-up task for the owner." size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!at} onClick={() => m.mutate(undefined)}>Schedule</Button></>}>
      <Field label="Follow up on"><Input type="datetime-local" value={at} min={new Date().toISOString().slice(0, 16)} onChange={(e) => setAt(e.target.value)} /></Field>
    </Dialog>
  );
}

function ConsentDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [f, setF] = useState({ channel: 'EMAIL', status: 'OPTED_OUT', source: '', note: '' });
  const m = useApiMutation(() => api(`/api/v1/crm/leads/${id}/consent`, { body: { ...f, source: f.source || null, note: f.note || null } }), { success: 'Consent recorded', invalidate: ['/api/v1/crm'], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Record consent" description="Opt-outs block outbound contact logging on that channel." size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate(undefined)}>Record</Button></>}>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Channel"><Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{['CALL', 'EMAIL', 'SMS', 'WHATSAPP'].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select></Field>
          <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="OPTED_IN">Opted in</option><option value="OPTED_OUT">Opted out</option></Select></Field>
        </div>
        <Field label="Source"><Input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="e.g. verbal request on call" /></Field>
        <Field label="Note"><Textarea value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function NotesTab({ id, notes, canWrite }: { id: string; notes: Profile['notes']; canWrite: boolean }) {
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const add = useApiMutation(() => api(`/api/v1/crm/leads/${id}/notes`, { body: { body, pinned } }), { success: 'Note added', invalidate: ['/api/v1/crm'], onSuccess: () => { setBody(''); setPinned(false); } });
  const del = useApiMutation((nid: string) => api(`/api/v1/crm/notes/${nid}`, { method: 'DELETE' }), { success: 'Note deleted', invalidate: ['/api/v1/crm'] });
  return (
    <div className="flex flex-col gap-4">
      {canWrite && (
        <div className="flex flex-col gap-2">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a note…" />
          <div className="flex items-center justify-between"><label className="flex items-center gap-2 text-xs text-muted"><Checkbox checked={pinned} onCheckedChange={setPinned} aria-label="Pin" /> Pin to top</label><Button size="sm" variant="primary" loading={add.isPending} disabled={!body.trim()} onClick={() => add.mutate(undefined)}>Add note</Button></div>
        </div>
      )}
      {notes.length === 0 ? <p className="py-6 text-center text-xs text-subtle">No notes yet</p> : notes.map((n) => (
        <div key={n.id} className="rounded-md border border-border px-3 py-2.5">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-subtle">{n.pinned && <Pin className="size-3" />}<span className="text-fg-2">{n.authorName}</span>· {fmtAgo(n.createdAt)}{n.mine && <button className="ml-auto hover:text-fg" aria-label="Delete note" onClick={() => del.mutate(n.id)}><Trash2 className="size-3" /></button>}</div>
          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg-2">{n.body}</p>
        </div>
      ))}
    </div>
  );
}

function CommsTab({ comms, consents }: { comms: Profile['comms']; consents: Profile['consents'] }) {
  return (
    <div className="flex flex-col gap-5">
      <Timeline items={comms.map((c) => ({ id: c.id, title: `${c.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} ${humanize(c.channel).toLowerCase()} · ${humanize(c.outcome).toLowerCase()}${c.durationSec ? ` · ${Math.round(c.durationSec / 60)} min` : ''}`, body: [c.subject, c.body].filter(Boolean).join('\n'), at: c.occurredAt, actor: c.userName, verification: c.verification }))} empty="No communication logged yet" />
      {consents.length > 0 && (
        <div><div className="eyebrow mb-2">Consent history</div>
          <ul className="flex flex-col gap-1 text-[12px]">{consents.map((c) => <li key={c.id} className="flex gap-2"><Badge tone={c.status === 'OPTED_OUT' ? 'danger' : 'ok'}>{humanize(c.channel)} · {c.status === 'OPTED_OUT' ? 'opted out' : 'opted in'}</Badge><span className="text-subtle">{c.source ?? ''} · {c.recordedBy} · {fmtDateTime(c.createdAt)}</span></li>)}</ul>
        </div>
      )}
    </div>
  );
}

function TasksTab({ tasks, canManage }: { tasks: Profile['tasks']; canManage: boolean }) {
  const [done, setDone] = useState<Profile['tasks'][number] | null>(null);
  const [note, setNote] = useState('');
  const complete = useApiMutation((b: { id: string; note: string }) => api(`/api/v1/crm/tasks/${b.id}`, { method: 'PATCH', body: { status: 'DONE', completionNote: b.note || null } }), { success: 'Task completed', invalidate: ['/api/v1/crm'], onSuccess: () => { setDone(null); setNote(''); } });
  if (!tasks.length) return <p className="py-6 text-center text-xs text-subtle">No tasks for this lead</p>;
  return (
    <ul className="flex flex-col">
      {tasks.map((t) => {
        const overdue = t.status !== 'DONE' && t.dueAt && new Date(t.dueAt) < new Date();
        return (
          <li key={t.id} className="flex items-center gap-3 border-b border-border/60 py-2 last:border-0">
            {canManage && t.status !== 'DONE' ? <Checkbox checked={false} onCheckedChange={() => setDone(t)} aria-label={`Complete ${t.title}`} /> : <Check className={`size-3.5 ${t.status === 'DONE' ? 'text-fg' : 'text-faint'}`} />}
            <div className="min-w-0 flex-1">
              <div className={`truncate text-[12.5px] ${t.status === 'DONE' ? 'text-subtle line-through' : ''}`}>{t.title}</div>
              <div className="text-[11px] text-subtle">{humanize(t.type)} · {t.assigneeName ?? 'Unassigned'}{t.completionNote ? ` · “${t.completionNote}”` : ''}</div>
            </div>
            <StatusBadge status={t.priority} />
            <span className={`text-[11px] ${overdue ? 'text-warn' : 'text-subtle'}`}>{t.dueAt ? fmtDateTime(t.dueAt) : 'No due date'}</span>
          </li>
        );
      })}
      <Dialog open={!!done} onOpenChange={(o) => !o && setDone(null)} title={`Complete “${done?.title}”`} size="sm" footer={<><Button variant="ghost" onClick={() => setDone(null)}>Cancel</Button><Button variant="primary" loading={complete.isPending} onClick={() => complete.mutate({ id: done!.id, note })}>Complete</Button></>}>
        <Field label="Completion note (optional)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
    </ul>
  );
}

function FilesTab({ id, files, canUpload, canView }: { id: string; files: Profile['attachments']; canUpload: boolean; canView: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<Profile['attachments'][number] | null>(null);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api(`/api/v1/crm/leads/${id}/attachments`, { body: fd });
      toast.success('File attached');
      location.reload();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-3">
      {canUpload && (
        <div className="flex items-center gap-3">
          <input ref={ref} type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
          <Button size="sm" loading={busy} onClick={() => ref.current?.click()}><Paperclip /> Attach file</Button>
          <span className="text-[11px] text-subtle">PDF, images or text · max 10 MB · viewed inline only</span>
        </div>
      )}
      {files.length === 0 ? <p className="py-6 text-center text-xs text-subtle">No files</p> : (
        <ul>{files.map((f) => (
          <li key={f.id} className="flex items-center gap-3 border-b border-border/60 py-2 last:border-0">
            <FileText className="size-4 text-subtle" />
            <div className="min-w-0 flex-1"><div className="truncate text-[12.5px]">{f.fileName}</div><div className="text-[11px] text-subtle">{(f.size / 1024).toFixed(0)} KB · {f.uploadedBy} · {fmtAgo(f.createdAt)}</div></div>
            {canView ? <Button size="xs" variant="ghost" onClick={() => setViewing(f)}>View</Button> : <span className="text-[11px] text-subtle">No view permission</span>}
          </li>
        ))}</ul>
      )}
      <Drawer open={!!viewing} onOpenChange={(o) => !o && setViewing(null)} title={viewing?.fileName} description="Viewing is logged. Downloads are not offered from the workspace." width="xl">
        {viewing && (viewing.mimeType.startsWith('image/')
          ? <img src={`/api/v1/crm/attachments/${viewing.id}`} alt={viewing.fileName} className="mx-auto max-h-[75vh] select-none" draggable={false} onContextMenu={(e) => e.preventDefault()} />
          : <iframe src={`/api/v1/crm/attachments/${viewing.id}`} title={viewing.fileName} sandbox={viewing.mimeType === 'application/pdf' ? undefined : ''} className="h-[75vh] w-full rounded border border-border bg-white" />)}
      </Drawer>
    </div>
  );
}

function EditDrawer({ lead, fields, onClose }: { lead: Profile['lead']; fields: Profile['fields']; onClose: () => void }) {
  const editable = ['fullName', 'company', 'jobTitle', 'city', 'state', 'country', 'industry'] as const;
  const [f, setF] = useState<Record<string, string>>({});
  const [cf, setCf] = useState<Record<string, unknown>>({ ...(lead.customFields ?? {}) });
  const [deal, setDeal] = useState({ dealValue: lead.dealValue != null ? String(lead.dealValue) : '', currency: lead.currency, expectedCloseDate: lead.expectedCloseDate ? String(lead.expectedCloseDate).slice(0, 10) : '', probability: lead.probability != null ? String(lead.probability) : '', priority: lead.priority });
  const save = useApiMutation(() => {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f)) body[k] = v.trim() === '' && k !== 'fullName' ? null : v.trim();
    body.priority = deal.priority;
    body.currency = deal.currency;
    body.dealValue = deal.dealValue === '' ? null : Number(deal.dealValue);
    body.probability = deal.probability === '' ? null : Number(deal.probability);
    body.expectedCloseDate = deal.expectedCloseDate ? new Date(deal.expectedCloseDate).toISOString() : null;
    if (fields.length) body.customFields = cf;
    return api(`/api/v1/crm/leads/${lead.id}`, { method: 'PATCH', body });
  }, { success: 'Lead updated', invalidate: ['/api/v1/crm'], onSuccess: onClose });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title="Edit lead" description="Source and campaign are set by the platform and cannot be changed." width="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {editable.map((k) => <Field key={k} label={humanize(k)}><Input value={f[k] ?? (lead[k] as string) ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
        <Field label="Replace email" hint="Leave blank to keep the current value"><Input type="email" value={f.email ?? ''} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Replace phone" hint="Leave blank to keep the current value"><Input value={f.phone ?? ''} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <div className="sm:col-span-2 eyebrow mt-2">Deal</div>
        <Field label="Deal value"><Input type="number" min={0} value={deal.dealValue} onChange={(e) => setDeal({ ...deal, dealValue: e.target.value })} /></Field>
        <Field label="Currency"><Input value={deal.currency} maxLength={3} onChange={(e) => setDeal({ ...deal, currency: e.target.value.toUpperCase() })} /></Field>
        <Field label="Expected close"><Input type="date" value={deal.expectedCloseDate} onChange={(e) => setDeal({ ...deal, expectedCloseDate: e.target.value })} /></Field>
        <Field label="Probability (%)"><Input type="number" min={0} max={100} value={deal.probability} onChange={(e) => setDeal({ ...deal, probability: e.target.value })} /></Field>
        <Field label="Priority"><Select value={deal.priority} onChange={(e) => setDeal({ ...deal, priority: e.target.value })}>{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</Select></Field>
        {fields.length > 0 && <div className="sm:col-span-2 eyebrow mt-2">Custom fields</div>}
        {fields.map((fd) => (
          <Field key={fd.key} label={`${fd.label}${fd.required ? ' *' : ''}`}>
            {fd.type === 'SELECT' ? <Select value={String(cf[fd.key] ?? '')} onChange={(e) => setCf({ ...cf, [fd.key]: e.target.value || null })}><option value="">—</option>{fd.options.map((o) => <option key={o}>{o}</option>)}</Select>
              : fd.type === 'BOOLEAN' ? <Select value={cf[fd.key] == null ? '' : String(cf[fd.key])} onChange={(e) => setCf({ ...cf, [fd.key]: e.target.value === '' ? null : e.target.value === 'true' })}><option value="">—</option><option value="true">Yes</option><option value="false">No</option></Select>
              : <Input type={fd.type === 'NUMBER' ? 'number' : fd.type === 'DATE' ? 'date' : 'text'} value={String(cf[fd.key] ?? '')} onChange={(e) => setCf({ ...cf, [fd.key]: e.target.value === '' ? null : fd.type === 'NUMBER' ? Number(e.target.value) : e.target.value })} />}
          </Field>
        ))}
      </div>
    </Drawer>
  );
}
