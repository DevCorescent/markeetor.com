'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, Ban, Check, Copy, ExternalLink, FileText, Home, Plus, Search, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/data/data-table';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button, buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, Drawer, Switch, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtDateTime, fmtInt, fmtPct } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';

type App = { id: string; status: string; businessName: string; contactName: string; email: string; phone: string | null; website: string | null; industry: string | null; country: string | null; flags: string[]; quality: number; createdAt: string; form: { name: string; slug: string } };
type Form = { id: string; slug: string; name: string; status: string; views: number; submissions: number; pending: number; approved: number; updatedAt: string; title: string; isHomepage: boolean };
type Stats = { views: number; submitted: number; pending: number; approved: number; rejected: number; spam: number; lastWeek: number };

const FLAG_INFO: Record<string, { label: string; tone: 'warn' | 'danger' | 'neutral' }> = {
  free_email: { label: 'Personal email', tone: 'neutral' },
  website_mismatch: { label: 'Website ≠ email domain', tone: 'warn' },
  fast_submit: { label: 'Filled very fast', tone: 'warn' },
  existing_client: { label: 'Already a client', tone: 'danger' },
  duplicate_application: { label: 'Applied before', tone: 'warn' },
  existing_user: { label: 'Email already has an account', tone: 'danger' },
};

export function OnboardingHub() {
  const [s, set] = useUrlState({ tab: 'applications' });
  const stats = useApiQuery<Stats>('/api/v1/onboarding/stats', { refetchInterval: 30_000 });
  const st = stats.data;
  return (
    <>
      <PageHeader title="Business onboarding" description="Public application forms for new businesses. Approve an application to create the workspace and email the owner a link to their dashboard." />
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Tile label="Form views" value={fmtInt(st?.views ?? 0)} />
        <Tile label="Applications" value={fmtInt(st?.submitted ?? 0)} sub={st?.views ? `${fmtPct(st.submitted / st.views, 1)} of views` : undefined} />
        <Tile label="Awaiting review" value={fmtInt(st?.pending ?? 0)} strong={(st?.pending ?? 0) > 0} />
        <Tile label="Activated" value={fmtInt(st?.approved ?? 0)} sub={st?.submitted ? `${fmtPct(st.approved / st.submitted, 0)} approval rate` : undefined} />
        <Tile label="This week" value={fmtInt(st?.lastWeek ?? 0)} />
        <Tile label="Spam blocked" value={fmtInt(st?.spam ?? 0)} />
      </div>
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}><TabsList className="mb-4"><TabsTrigger value="applications">Applications{st?.pending ? ` (${st.pending})` : ''}</TabsTrigger><TabsTrigger value="forms">Forms</TabsTrigger></TabsList></Tabs>
      {s.tab === 'applications' ? <Applications onChange={() => stats.refetch()} /> : <Forms />}
    </>
  );
}

const Tile = ({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) => (
  <Card className={cn('px-4 py-3.5', strong && 'border-fg ring-1 ring-fg')}><div className="eyebrow">{label}</div><div className="tnum mt-2 text-[22px] leading-none font-[520] tracking-[-0.03em]">{value}</div>{sub && <div className="mt-1.5 text-[11px] text-subtle">{sub}</div>}</Card>
);

function QualityBar({ q }: { q: number }) {
  return <div className="flex w-24 items-center gap-2"><div className="h-1.5 flex-1 rounded-full bg-surface-3"><div className="h-full rounded-full bg-fg" style={{ width: `${q}%`, opacity: 0.35 + q / 160 }} /></div><span className="tnum w-6 text-right text-[11px] text-muted">{q}</span></div>;
}

function Applications({ onChange }: { onChange: () => void }) {
  const sp = useSearchParams();
  const [status, setStatus] = useState('PENDING');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(sp.get('id'));
  const { data, isFetching, refetch } = useApiQuery<{ total: number; rows: App[] }>(`/api/v1/onboarding/applications?page=${page}&pageSize=25${status ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`, { refetchInterval: 30_000 });
  const cols: ColumnDef<App, unknown>[] = [
    { id: 'biz', header: 'Business', cell: ({ row: { original: a } }) => <div className="min-w-[180px]"><div className="font-medium text-fg">{a.businessName}</div><div className="text-[11px] text-subtle">{[a.industry, a.country].filter(Boolean).join(' · ') || a.website || '—'}</div></div> },
    { id: 'contact', header: 'Contact', cell: ({ row: { original: a } }) => <div><div>{a.contactName}</div><div className="text-[11px] text-subtle">{a.email}</div></div> },
    { id: 'quality', header: 'Quality', cell: ({ row: { original: a } }) => <QualityBar q={a.quality} /> },
    { id: 'flags', header: 'Signals', cell: ({ row: { original: a } }) => <div className="flex max-w-[220px] flex-wrap gap-1">{a.flags.length ? a.flags.map((f) => <Badge key={f} tone={FLAG_INFO[f]?.tone ?? 'neutral'}>{FLAG_INFO[f]?.label ?? f}</Badge>) : <span className="text-[11.5px] text-subtle">No concerns</span>}</div> },
    { id: 'form', header: 'Form', cell: ({ row: { original: a } }) => <span className="text-muted">{a.form.name}</span> },
    { id: 'status', header: 'Status', cell: ({ row: { original: a } }) => <StatusBadge status={a.status} /> },
    { id: 'at', header: 'Received', cell: ({ row: { original: a } }) => <span className="text-subtle">{fmtAgo(a.createdAt)}</span> },
  ];
  return (
    <>
      <DataTable columns={cols} data={data?.rows ?? []} total={data?.total ?? 0} page={page} pageSize={25} onPage={setPage} loading={isFetching} getRowId={(r) => r.id} onRowClick={(r) => setOpen(r.id)}
        empty={<div className="py-12 text-center text-[12.5px] text-subtle">{status === 'PENDING' ? 'No applications waiting — share a form to start receiving them.' : 'Nothing here.'}</div>}
        toolbar={
          <div className="flex w-full flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-border-strong p-0.5">{[['PENDING', 'Pending'], ['APPROVED', 'Activated'], ['REJECTED', 'Rejected'], ['SPAM', 'Spam'], ['', 'All']].map(([v, l]) => <button key={l} type="button" onClick={() => { setStatus(v); setPage(1); }} className={cn('h-7 rounded px-2.5 text-[12px]', status === v ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{l}</button>)}</div>
            <div className="relative ml-auto w-full max-w-[240px]"><Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search business, name or email" className="h-7 pl-8 text-[12px]" /></div>
          </div>
        } />
      {open && <ApplicationDrawer id={open} onClose={() => setOpen(null)} onChange={() => { refetch(); onChange(); }} />}
    </>
  );
}

type AppDetail = App & {
  answers: Record<string, unknown>; labels: Record<string, string>; leadInterests: { criteria?: Record<string, unknown>; summary?: string; matches?: number } | null;
  ip: string | null; userAgent: string | null; reason: string | null; notes: string | null; decidedAt: string | null;
  form: { id: string; name: string; slug: string; activation: { maxUsers: number; maxActiveLeads: number; dailyAllocationLimit: number; monthlyAllocationLimit: number } };
  organization: { id: string; name: string; code: string; status: string } | null;
};

function ApplicationDrawer({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { data: a, refetch } = useApiQuery<AppDetail>(`/api/v1/onboarding/applications/${id}`);
  const [approve, setApprove] = useState(false);
  const [reject, setReject] = useState<null | 'reject' | 'spam'>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const saveNotes = async () => { try { await api(`/api/v1/onboarding/applications/${id}`, { method: 'PATCH', body: { notes: notes ?? '' } }); toast.success('Notes saved'); setNotes(null); refetch(); } catch (e) { toast.error(errorMessage(e)); } };
  const keys = a ? Object.keys(a.labels) : [];
  const order = (k: string) => (keys.indexOf(k) + 1 || 999);
  const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v == null || v === '' ? '—' : String(v));
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={a?.businessName ?? 'Application'} description={a ? `${a.contactName} · ${a.email} · ${fmtDateTime(a.createdAt)}` : ''} width="lg"
      footer={a && a.status !== 'APPROVED' ? (
        <>
          {a.status !== 'SPAM' && <Button variant="ghost" onClick={() => setReject('spam')}>Mark as spam</Button>}
          {a.status !== 'REJECTED' && <Button variant="ghost" onClick={() => setReject('reject')}><Ban /> Reject</Button>}
          <Button variant="primary" onClick={() => setApprove(true)}><Check /> Approve & activate</Button>
        </>
      ) : undefined}>
      {!a ? <Skeleton className="h-64" /> : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={a.status} />
            <span className="flex items-center gap-2 text-[12px] text-muted">Quality <QualityBar q={a.quality} /></span>
            {a.organization && <Link href={`/admin/organizations/${a.organization.id}`} className="ml-auto flex items-center gap-1 text-[12px] font-medium hover:underline">Workspace {a.organization.code} <ExternalLink className="size-3" /></Link>}
          </div>
          {a.flags.length > 0 && (
            <div className="rounded-lg border border-warn/40 bg-warn-dim px-3.5 py-2.5">
              <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-warn"><AlertTriangle className="size-3.5" />Things to check</div>
              <ul className="flex flex-col gap-0.5 text-[12px] text-fg-2">{a.flags.map((f) => <li key={f}>• {FLAG_INFO[f]?.label ?? f}</li>)}</ul>
            </div>
          )}
          {a.reason && <InlineNotice tone="warn">Reason: {a.reason}</InlineNotice>}
          <section>
            <div className="eyebrow mb-2">Answers</div>
            <dl className="grid grid-cols-[minmax(120px,38%)_1fr] gap-x-4 gap-y-2 rounded-lg border border-border px-4 py-3 text-[12.5px]">
              {Object.entries(a.answers).sort(([x], [y]) => order(x) - order(y)).map(([k, v]) => <div key={k} className="contents"><dt className="text-subtle">{a.labels[k] ?? k}</dt><dd className="break-words">{show(v)}</dd></div>)}
            </dl>
          </section>
          {a.leadInterests && (
            <section>
              <div className="eyebrow mb-2 flex items-center gap-1.5"><Sparkles className="size-3.5" />Leads they’re looking for</div>
              <div className="rounded-lg border border-border px-4 py-3 text-[12.5px]">
                <div className="flex flex-wrap gap-1.5">{(a.leadInterests.summary ?? '').split(', ').filter(Boolean).map((x) => <Badge key={x} tone="outline">{x}</Badge>)}</div>
                {a.leadInterests.matches != null && <div className="mt-2 text-muted"><b className="tnum text-fg">{fmtInt(a.leadInterests.matches)}</b> matching leads were available when they applied.</div>}
              </div>
            </section>
          )}
          <section>
            <div className="eyebrow mb-2">Internal notes</div>
            <Textarea rows={3} value={notes ?? a.notes ?? ''} onChange={(e) => setNotes(e.target.value)} placeholder="Visible to platform staff only" />
            {notes != null && <div className="mt-2 flex justify-end"><Button size="sm" onClick={saveNotes}>Save notes</Button></div>}
          </section>
          <div className="text-[11px] text-subtle">From {a.form.name} (/join/{a.form.slug}){a.ip ? ` · IP ${a.ip}` : ''}</div>
        </div>
      )}
      {a && approve && <ApproveDialog a={a} onClose={() => setApprove(false)} onDone={() => { setApprove(false); refetch(); onChange(); }} />}
      {a && reject && <RejectDialog id={a.id} spam={reject === 'spam'} onClose={() => setReject(null)} onDone={() => { setReject(null); refetch(); onChange(); }} />}
    </Drawer>
  );
}

function ApproveDialog({ a, onClose, onDone }: { a: AppDetail; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ businessName: a.businessName, ownerName: a.contactName, ownerEmail: a.email, ...a.form.activation });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ organization: { code: string; name: string }; inviteSentTo: string | null }>(`/api/v1/onboarding/applications/${a.id}/approve`, { body: f });
      toast.success(`${r.organization.name} is live`, { description: r.inviteSentTo ? `Invitation emailed to ${r.inviteSentTo}` : `Workspace ${r.organization.code} created` });
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const num = (k: keyof typeof f) => <Input type="number" min={0} value={f[k] as number} onChange={(e) => setF({ ...f, [k]: Math.max(0, Math.round(Number(e.target.value))) })} />;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Approve & activate" description="Creates the workspace, applies the limits below and emails the owner an invitation to set a password and open their dashboard." size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}><Check /> Activate workspace</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Workspace name" className="sm:col-span-2"><Input value={f.businessName} onChange={(e) => setF({ ...f, businessName: e.target.value })} /></Field>
        <Field label="Owner name"><Input value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></Field>
        <Field label="Owner email"><Input type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} /></Field>
        <Field label="Max users">{num('maxUsers')}</Field>
        <Field label="Max active leads">{num('maxActiveLeads')}</Field>
        <Field label="Daily allocation limit">{num('dailyAllocationLimit')}</Field>
        <Field label="Monthly allocation limit">{num('monthlyAllocationLimit')}</Field>
      </div>
    </Dialog>
  );
}

function RejectDialog({ id, spam, onClose, onDone }: { id: string; spam: boolean; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState(spam ? 'Spam' : '');
  const [notify, setNotify] = useState(!spam);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await api(`/api/v1/onboarding/applications/${id}/reject`, { body: { reason, notify, spam } }); toast.success(spam ? 'Marked as spam' : 'Application rejected'); onDone(); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={spam ? 'Mark as spam' : 'Reject application'} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={submit}>{spam ? 'Mark as spam' : 'Reject'}</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label={spam ? 'Note' : 'Reason (shared with the applicant if notified)'}><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {!spam && <label className="flex items-center justify-between text-[12.5px]">Email the applicant<Switch checked={notify} onCheckedChange={setNotify} aria-label="Notify" /></label>}
      </div>
    </Dialog>
  );
}

function Forms() {
  const router = useRouter();
  const { data } = useApiQuery<{ forms: Form[] }>('/api/v1/onboarding/forms');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('Business application');
  const [copyFrom, setCopyFrom] = useState('');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const create = async () => {
    try {
      const f = await api<{ id: string }>('/api/v1/onboarding/forms', { body: { name, copyFrom: copyFrom || null } });
      router.push(`/admin/onboarding/forms/${f.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <>
      <div className="mb-3 flex justify-end"><Button variant="primary" onClick={() => setCreating(true)}><Plus /> New form</Button></div>
      {!data ? <Skeleton className="h-48" /> : !data.forms.length ? (
        <Card className="flex flex-col items-center gap-2 py-14 text-center">
          <FileText className="size-7 text-subtle" /><div className="text-[14px] font-medium">Create your first onboarding form</div>
          <p className="max-w-md text-[12.5px] text-subtle">Design a branded application page for new businesses. Applications land here for approval; activated businesses get their own dashboard.</p>
          <Button className="mt-2" variant="primary" onClick={() => setCreating(true)}><Plus /> New form</Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.forms.map((f) => (
            <Card key={f.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-2 px-4 pt-4">
                <div className="min-w-0"><div className="truncate text-[14px] font-medium">{f.name}</div><div className="truncate text-[12px] text-subtle">{f.title}</div></div>
                <div className="flex shrink-0 items-center gap-1">{f.isHomepage && <Badge tone="solid"><Home className="size-3" />Homepage</Badge>}<Badge tone={f.status === 'PUBLISHED' ? 'ok' : f.status === 'CLOSED' ? 'dim' : 'outline'} dot>{f.status === 'PUBLISHED' ? 'Live' : f.status === 'CLOSED' ? 'Closed' : 'Draft'}</Badge></div>
              </div>
              <div className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[11.5px] text-muted">
                <span className="truncate">{origin}/join/{f.slug}</span>
                <button type="button" aria-label="Copy link" className="ml-auto text-subtle hover:text-fg" onClick={() => { navigator.clipboard.writeText(`${origin}/join/${f.slug}`); toast.success('Link copied'); }}><Copy className="size-3.5" /></button>
                <a href={`/join/${f.slug}${f.status === 'DRAFT' ? '?preview=1' : ''}`} target="_blank" rel="noreferrer" aria-label="Open" className="text-subtle hover:text-fg"><ExternalLink className="size-3.5" /></a>
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2 px-4 text-center">
                {[['Views', f.views], ['Applied', f.submissions], ['Pending', f.pending], ['Active', f.approved]].map(([l, v]) => <div key={l as string}><div className="tnum text-[16px] font-semibold">{fmtInt(v as number)}</div><div className="text-[10.5px] text-subtle">{l}</div></div>)}
              </div>
              <div className="mt-auto flex items-center justify-between border-t border-border px-4 py-2.5 text-[11.5px] text-subtle">
                <span>{f.views ? `${fmtPct(f.submissions / f.views, 1)} conversion` : 'No views yet'} · edited {fmtAgo(f.updatedAt)}</span>
                <Link href={`/admin/onboarding/forms/${f.id}`} className={buttonClass({ size: 'xs', variant: 'outline' })}>Edit</Link>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={creating} onOpenChange={setCreating} title="New onboarding form" size="sm" footer={<><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" disabled={name.trim().length < 2} onClick={create}>Create & design</Button></>}>
        <div className="flex flex-col gap-3">
          <Field label="Name (internal)"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          {(data?.forms.length ?? 0) > 0 && <Field label="Start from"><Select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}><option value="">Recommended template</option>{data!.forms.map((f) => <option key={f.id} value={f.id}>Copy of {f.name}</option>)}</Select></Field>}
        </div>
      </Dialog>
    </>
  );
}
