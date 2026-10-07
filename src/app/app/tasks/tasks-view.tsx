'use client';
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Checkbox, Dialog, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { EmptyState, Skeleton } from '@/components/ui/states';
import { Pagination } from '@/components/ui/table-bits';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtDateTime, humanize } from '@/lib/format';
import { useApiMutation, useApiQuery, useUrlState } from '@/lib/hooks';

type Task = { id: string; title: string; description: string | null; type: string; priority: string; status: string; dueAt: string | null; recurrence: string; assigneeId: string | null; createdById: string; completionNote: string | null; escalatedAt: string | null; assignee: { id: string; name: string } | null; clientLead: { id: string; fullName: string } | null };

export function TasksView({ selfId, team, canManage, canDelegate }: { selfId: string; team: boolean; canManage: boolean; canDelegate: boolean }) {
  const [s, set] = useUrlState({ scope: 'mine', status: 'open', view: 'list', page: '1' });
  const members = useApiQuery<{ members: { id: string; name: string }[] }>('/api/v1/crm/leads/facets');
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Tasks & follow-ups" description="Calls, meetings, emails and follow-ups — personal and team." actions={canManage && <Button variant="primary" onClick={() => setCreating(true)}><Plus /> New task</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Tabs value={s.scope} onValueChange={(v) => set({ scope: v, page: '1' })}><TabsList className="border-0"><TabsTrigger value="mine">My tasks</TabsTrigger>{team && <TabsTrigger value="team">Team</TabsTrigger>}{canDelegate && <TabsTrigger value="delegated">Delegated by me</TabsTrigger>}</TabsList></Tabs>
        <div className="ml-auto flex items-center gap-2">
          {s.view === 'list' && (
            <div className="flex items-center rounded-md border border-border bg-surface p-0.5">
              {['open', 'overdue', 'done', 'all'].map((st) => <button key={st} onClick={() => set({ status: st, page: '1' })} className={`h-6 rounded px-2 text-[11.5px] capitalize ${s.status === st ? 'bg-fg text-inverse' : 'text-muted hover:text-fg'}`}>{st}</button>)}
            </div>
          )}
          <div className="flex items-center rounded-md border border-border bg-surface p-0.5">
            {['list', 'calendar'].map((v) => <button key={v} onClick={() => set({ view: v })} className={`h-6 rounded px-2 text-[11.5px] capitalize ${s.view === v ? 'bg-fg text-inverse' : 'text-muted hover:text-fg'}`}>{v}</button>)}
          </div>
        </div>
      </div>
      {s.view === 'list' ? <TaskList scope={s.scope!} status={s.status!} page={Number(s.page)} onPage={(p) => set({ page: String(p) })} selfId={selfId} canManage={canManage} members={members.data?.members ?? []} canDelegate={canDelegate} /> : <Calendar scope={s.scope!} />}
      {creating && <TaskForm onClose={() => setCreating(false)} members={members.data?.members ?? []} canDelegate={canDelegate} selfId={selfId} />}
    </>
  );
}

function TaskList({ scope, status, page, onPage, selfId, canManage, members, canDelegate }: { scope: string; status: string; page: number; onPage: (p: number) => void; selfId: string; canManage: boolean; members: { id: string; name: string }[]; canDelegate: boolean }) {
  const { data, isLoading } = useApiQuery<{ total: number; rows: Task[] }>(`/api/v1/crm/tasks?scope=${scope}&status=${status}&page=${page}&pageSize=50`);
  const [complete, setComplete] = useState<Task | null>(null);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<Task | null>(null);
  const [del, setDel] = useState<Task | null>(null);
  const done = useApiMutation((b: { id: string; note: string }) => api(`/api/v1/crm/tasks/${b.id}`, { method: 'PATCH', body: { status: 'DONE', completionNote: b.note || null } }), { success: 'Task completed', invalidate: ['/api/v1/crm'], onSuccess: () => { setComplete(null); setNote(''); } });
  const reopen = useApiMutation((id: string) => api(`/api/v1/crm/tasks/${id}`, { method: 'PATCH', body: { status: 'OPEN' } }), { success: 'Task reopened', invalidate: ['/api/v1/crm'] });
  const remove = useApiMutation((id: string) => api(`/api/v1/crm/tasks/${id}`, { method: 'DELETE' }), { success: 'Task deleted', invalidate: ['/api/v1/crm'] });
  if (isLoading) return <Skeleton className="h-64" />;
  if (!data?.rows.length) return <Card><EmptyState title={status === 'overdue' ? 'Nothing overdue' : 'No tasks'} description="Tasks created from leads, follow-ups and automation appear here." /></Card>;
  return (
    <Card>
      <ul>
        {data.rows.map((t) => {
          const overdue = t.status !== 'DONE' && t.dueAt && new Date(t.dueAt) < new Date();
          return (
            <li key={t.id} className="group flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-0">
              {canManage ? <Checkbox checked={t.status === 'DONE'} onCheckedChange={(c) => (c ? setComplete(t) : reopen.mutate(t.id))} aria-label={`Toggle ${t.title}`} /> : <span className="size-3.5" />}
              <button className="min-w-0 flex-1 text-left" onClick={() => canManage && setEditing(t)}>
                <div className={cn('truncate text-[12.5px]', t.status === 'DONE' && 'text-subtle line-through')}>{t.title}{t.recurrence !== 'NONE' && <span className="ml-1.5 text-[10.5px] text-subtle">↻ {t.recurrence.toLowerCase()}</span>}</div>
                <div className="truncate text-[11px] text-subtle">{humanize(t.type)}{t.clientLead && <> · <Link className="hover:underline" href={`/app/leads/${t.clientLead.id}`} onClick={(e) => e.stopPropagation()}>{t.clientLead.fullName}</Link></>}{scope !== 'mine' && ` · ${t.assignee?.name ?? 'Unassigned'}`}{t.completionNote && ` · “${t.completionNote}”`}</div>
              </button>
              {t.escalatedAt && <StatusBadge status="CRITICAL" className="hidden sm:inline-flex" />}
              <StatusBadge status={t.priority} />
              <span className={cn('w-36 text-right text-[11.5px]', overdue ? 'text-warn' : 'text-subtle')}>{t.dueAt ? fmtDateTime(t.dueAt) : 'No due date'}</span>
              {canManage && t.createdById === selfId && <button className="p-1 text-subtle opacity-0 group-hover:opacity-100 hover:text-fg" aria-label="Delete" onClick={() => setDel(t)}><Trash2 className="size-3.5" /></button>}
            </li>
          );
        })}
      </ul>
      <Pagination page={page} pageSize={50} total={data.total} onPage={onPage} />
      <Dialog open={!!complete} onOpenChange={(o) => !o && setComplete(null)} title={`Complete “${complete?.title}”`} size="sm" footer={<><Button variant="ghost" onClick={() => setComplete(null)}>Cancel</Button><Button variant="primary" loading={done.isPending} onClick={() => done.mutate({ id: complete!.id, note })}>Complete</Button></>}>
        <Field label="Completion note (optional)" hint={complete?.recurrence !== 'NONE' ? 'The next occurrence is created automatically.' : undefined}><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
      {editing && <TaskForm task={editing} onClose={() => setEditing(null)} members={members} canDelegate={canDelegate} selfId={selfId} />}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title="Delete task" danger confirmLabel="Delete" onConfirm={() => remove.mutateAsync(del!.id)} />
    </Card>
  );
}

function TaskForm({ task, onClose, members, canDelegate, selfId }: { task?: Task; onClose: () => void; members: { id: string; name: string }[]; canDelegate: boolean; selfId: string }) {
  const [f, setF] = useState({ title: task?.title ?? '', description: task?.description ?? '', type: task?.type ?? 'TODO', priority: task?.priority ?? 'MEDIUM', dueAt: task?.dueAt ? new Date(task.dueAt).toISOString().slice(0, 16) : '', assigneeId: task?.assigneeId ?? selfId, recurrence: task?.recurrence ?? 'NONE' });
  const save = useApiMutation(() => api(task ? `/api/v1/crm/tasks/${task.id}` : '/api/v1/crm/tasks', { method: task ? 'PATCH' : 'POST', body: { ...f, description: f.description || null, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : null } }), { success: task ? 'Task updated' : 'Task created', invalidate: ['/api/v1/crm'], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={task ? 'Edit task' : 'New task'} size="md" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={f.title.trim().length < 2} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Title" className="sm:col-span-2"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['TODO', 'CALL', 'MEETING', 'EMAIL', 'FOLLOW_UP'].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
        <Field label="Priority"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
        <Field label="Due"><Input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
        <Field label="Repeats"><Select value={f.recurrence} onChange={(e) => setF({ ...f, recurrence: e.target.value })}>{['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
        {canDelegate && <Field label="Assignee" className="sm:col-span-2"><Select value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}>{members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === selfId ? ' (me)' : ''}</option>)}</Select></Field>}
      </div>
    </Dialog>
  );
}

function Calendar({ scope }: { scope: string }) {
  const [month, setMonth] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });
  const start = new Date(month); start.setDate(1 - ((month.getDay() + 6) % 7));
  const end = new Date(start); end.setDate(start.getDate() + 42);
  const { data } = useApiQuery<{ rows: Task[] }>(`/api/v1/crm/tasks?scope=${scope}&status=all&from=${start.toISOString()}&to=${end.toISOString()}&pageSize=200`);
  const byDay = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of data?.rows ?? []) if (t.dueAt) { const k = new Date(t.dueAt).toDateString(); m.set(k, [...(m.get(k) ?? []), t]); }
    return m;
  }, [data]);
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const today = new Date().toDateString();
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-[13px] font-medium">{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft /></Button>
          <Button size="sm" variant="ghost" onClick={() => { const d = new Date(); d.setDate(1); setMonth(d); }}>Today</Button>
          <Button size="icon" variant="ghost" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight /></Button>
        </div>
      </div>
      <div className="grid grid-cols-7 border-b border-border text-[10.5px] uppercase tracking-[0.08em] text-subtle">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="px-2 py-1.5">{d}</div>)}</div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const items = byDay.get(d.toDateString()) ?? [];
          const inMonth = d.getMonth() === month.getMonth();
          return (
            <div key={d.toISOString()} className={cn('min-h-[96px] border-r border-b border-border/60 p-1.5 [&:nth-child(7n)]:border-r-0', !inMonth && 'bg-bg/60')}>
              <div className={cn('mb-1 text-[11px]', d.toDateString() === today ? 'inline-grid size-5 place-items-center rounded-full bg-fg text-inverse' : inMonth ? 'text-muted' : 'text-faint')}>{d.getDate()}</div>
              <div className="flex flex-col gap-0.5">
                {items.slice(0, 3).map((t) => (
                  <div key={t.id} title={t.title} className={cn('truncate rounded px-1 py-0.5 text-[10.5px]', t.status === 'DONE' ? 'text-subtle line-through' : new Date(t.dueAt!) < new Date() ? 'bg-warn-dim text-warn' : 'bg-surface-3 text-fg-2')}>
                    {new Date(t.dueAt!).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} {t.title}
                  </div>
                ))}
                {items.length > 3 && <div className="px-1 text-[10px] text-subtle">+{items.length - 3} more</div>}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
