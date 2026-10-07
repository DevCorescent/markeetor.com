'use client';
import { AlarmClock, ArrowRight, CalendarCheck, CheckSquare, Flame, Hourglass, Moon, PhoneCall, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtDateTime, fmtInt, humanize } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';

type L = { id: string; fullName: string; company: string | null; jobTitle: string | null; city: string | null; country: string | null; industry: string | null; score: number; status: string; createdAt: string; nextFollowUpAt: string | null; lastActivityAt: string | null; owner: { name: string } | null; hoursWaiting?: number; breached?: boolean };
type T = { id: string; title: string; type: string; priority: string; dueAt: string | null; clientLeadId: string | null; clientLead: { fullName: string; company: string | null } | null; assignee: { name: string } | null };
type Q = { slaHours: number; staleDays: number; scope: 'mine' | 'team'; counts: Record<'overdue' | 'dueToday' | 'uncontacted' | 'stale' | 'tasks', number>; overdue: L[]; dueToday: L[]; uncontacted: L[]; stale: L[]; tasks: T[] };

const waiting = (h: number) => (h < 1 ? 'just now' : h < 48 ? `${h}h waiting` : `${Math.round(h / 24)}d waiting`);

const TONE = { danger: 'bg-danger-dim text-danger', warn: 'bg-warn-dim text-warn', info: 'bg-info-dim text-info', accent: 'bg-accent-dim text-accent', ok: 'bg-ok-dim text-ok' } as const;

function LeadRow({ l, right, showOwner }: { l: L; right: React.ReactNode; showOwner: boolean }) {
  return (
    <Link href={`/app/leads/${l.id}`} className="group flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-0 hover:bg-surface-2">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-[11px] font-semibold">{l.fullName.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{l.fullName}</div>
        <div className="truncate text-[11.5px] text-subtle">{[l.jobTitle, l.company, l.industry].filter(Boolean).join(' · ') || '—'}{showOwner && l.owner ? ` · ${l.owner.name}` : ''}</div>
      </div>
      <div className="shrink-0 text-right text-[11.5px]">{right}</div>
      <ArrowRight className="size-3.5 shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  );
}

function Lane({ icon: I, tone, title, hint, count, children, empty }: { icon: React.ComponentType<{ className?: string }>; tone: keyof typeof TONE; title: string; hint: string; count: number; children: React.ReactNode; empty: string }) {
  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className={cn('grid size-8 place-items-center rounded-lg', TONE[tone])}><I className="size-4" /></span>
        <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium">{title}</div><div className="truncate text-[11.5px] text-subtle">{hint}</div></div>
        <span className={cn('tnum rounded-full px-2.5 py-0.5 text-[12px] font-semibold', count ? TONE[tone] : 'bg-surface-3 text-subtle')}>{fmtInt(count)}</span>
      </div>
      <div className="max-h-[420px] overflow-y-auto">{count ? children : <div className="flex items-center justify-center gap-2 px-4 py-8 text-[12.5px] text-subtle"><Sparkles className="size-3.5" />{empty}</div>}</div>
    </Card>
  );
}

export function TodayView({ team, name, date }: { team: boolean; name: string; date: string }) {
  const [s, set] = useUrlState({ scope: team ? 'team' : 'mine' });
  const { data: q, error } = useApiQuery<Q>(`/api/v1/crm/today${s.scope === 'mine' ? '?mine=1' : ''}`, { refetchInterval: 60_000 });
  if (error) return <ErrorState description={errorMessage(error)} />;
  const total = q ? q.counts.overdue + q.counts.dueToday + q.counts.uncontacted + q.counts.tasks : 0;
  const showOwner = s.scope === 'team';
  return (
    <>
      <PageHeader eyebrow={date} title={`Today, ${name}`}
        description={q ? (total ? `${fmtInt(total)} things need you today — start at the top.` : 'You’re all caught up.') : 'Your follow-ups, first contacts and tasks for today.'}
        actions={team ? (
          <div className="inline-flex rounded-md border border-border p-0.5 text-[12px]">
            {(['mine', 'team'] as const).map((k) => <button key={k} type="button" onClick={() => set({ scope: k })} className={cn('rounded px-3 py-1', s.scope === k ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{k === 'mine' ? 'My work' : 'Whole team'}</button>)}
          </div>
        ) : undefined} />
      {!q ? <Skeleton className="h-96" /> : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Lane icon={Flame} tone="danger" title="Call first — new leads" hint={`Never contacted · best leads first · target ${q.slaHours}h`} count={q.counts.uncontacted} empty="Every lead has been contacted">
            {q.uncontacted.map((l) => <LeadRow key={l.id} l={l} showOwner={showOwner} right={<><div className={cn('font-medium', l.breached ? 'text-danger' : 'text-warn')}>{waiting(l.hoursWaiting!)}</div><div className="text-subtle">score {l.score}</div></>} />)}
          </Lane>
          <Lane icon={AlarmClock} tone="warn" title="Overdue follow-ups" hint="Promised a follow-up that hasn’t happened" count={q.counts.overdue} empty="No overdue follow-ups">
            {q.overdue.map((l) => <LeadRow key={l.id} l={l} showOwner={showOwner} right={<><div className="font-medium text-warn">{fmtAgo(l.nextFollowUpAt!)}</div><div className="text-subtle">{humanize(l.status)}</div></>} />)}
          </Lane>
          <Lane icon={CalendarCheck} tone="info" title="Follow-ups due today" hint="Scheduled for later today" count={q.counts.dueToday} empty="Nothing else scheduled today">
            {q.dueToday.map((l) => <LeadRow key={l.id} l={l} showOwner={showOwner} right={<><div className="font-medium text-info">{new Date(l.nextFollowUpAt!).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div><div className="text-subtle">{humanize(l.status)}</div></>} />)}
          </Lane>
          <Lane icon={CheckSquare} tone="accent" title="Tasks due" hint="Overdue and due today" count={q.counts.tasks} empty="No tasks due">
            {q.tasks.map((t) => (
              <Link key={t.id} href={t.clientLeadId ? `/app/leads/${t.clientLeadId}` : '/app/tasks'} className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-0 hover:bg-surface-2">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-dim text-accent">{t.type === 'CALL' ? <PhoneCall className="size-3.5" /> : <CheckSquare className="size-3.5" />}</span>
                <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium">{t.title}</div><div className="truncate text-[11.5px] text-subtle">{t.clientLead ? [t.clientLead.fullName, t.clientLead.company].filter(Boolean).join(' · ') : humanize(t.type)}{showOwner && t.assignee ? ` · ${t.assignee.name}` : ''}</div></div>
                <div className={cn('shrink-0 text-[11.5px]', t.dueAt && new Date(t.dueAt) < new Date() ? 'font-medium text-danger' : 'text-muted')}>{t.dueAt ? fmtDateTime(t.dueAt) : '—'}</div>
              </Link>
            ))}
          </Lane>
          <div className="xl:col-span-2">
            <Lane icon={Moon} tone="ok" title="Going cold" hint={`Contacted, but no activity for ${q.staleDays}+ days and no next step`} count={q.counts.stale} empty="No leads going cold">
              {q.stale.map((l) => <LeadRow key={l.id} l={l} showOwner={showOwner} right={<><div className="text-muted">{l.lastActivityAt ? `last touch ${fmtAgo(l.lastActivityAt)}` : 'no activity'}</div><div className="text-subtle">{humanize(l.status)}</div></>} />)}
            </Lane>
          </div>
          <p className="flex items-center gap-1.5 text-[11.5px] text-subtle xl:col-span-2"><Hourglass className="size-3.5" />Leads contacted within an hour are far more likely to convert. Use Call or WhatsApp on a lead to reach them in one tap and log the outcome.</p>
        </div>
      )}
    </>
  );
}
