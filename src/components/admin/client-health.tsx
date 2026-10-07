'use client';
import { ArrowRight, CircleAlert, CircleCheck, Coins, Rocket } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { fmtInt } from '@/lib/format';

export type Health = {
  organizationId: string; name: string; score: number; status: 'healthy' | 'watch' | 'at_risk'; expansion: boolean; reasons: { tone: 'good' | 'bad'; text: string }[];
  metrics: { members: number; activeMembers: number; comms14d: number; leads30d: number; medianHoursToContact: number | null; backlog: number; purchases30d: number; purchasesPrev30d: number; spend30d: number; reports30d: number; delivered30d: number; credits: number; creditDaysLeft: number | null };
};
export const HEALTH_TONE = { healthy: 'bg-ok-dim text-ok', watch: 'bg-warn-dim text-warn', at_risk: 'bg-danger-dim text-danger' } as const;
export const HEALTH_LABEL = { healthy: 'Healthy', watch: 'Watch', at_risk: 'At risk' } as const;

export function ScoreRing({ score, status, size = 44 }: { score: number; status: Health['status']; size?: number }) {
  const r = size / 2 - 4, c = 2 * Math.PI * r;
  const color = status === 'healthy' ? 'var(--ok)' : status === 'watch' ? 'var(--warn)' : 'var(--danger)';
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden><circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth="4" /><circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`} /></svg>
      <span className="tnum absolute text-[13px] font-semibold">{score}</span>
    </span>
  );
}

export function HealthCard({ h, link = true }: { h: Health; link?: boolean }) {
  const m = h.metrics;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-3">
        <ScoreRing score={h.score} status={h.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium">{h.name}</div>
          <div className="mt-0.5 flex flex-wrap gap-1.5"><span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-medium', HEALTH_TONE[h.status])}>{HEALTH_LABEL[h.status]}</span>{h.expansion && <span className="inline-flex items-center gap-1 rounded-full bg-accent-dim px-2 py-0.5 text-[10.5px] font-medium text-accent"><Rocket className="size-3" />Ready to grow</span>}</div>
        </div>
        {link && <Link href={`/admin/organizations/${h.organizationId}?tab=timeline`} className="text-subtle hover:text-fg" aria-label="Open client"><ArrowRight className="size-4" /></Link>}
      </div>
      <ul className="flex flex-col gap-1">
        {h.reasons.map((r, i) => <li key={i} className="flex items-start gap-1.5 text-[12px]">{r.tone === 'good' ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-ok" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />}<span className="text-fg-2">{r.text}</span></li>)}
        {!h.reasons.length && <li className="text-[12px] text-subtle">Not enough activity to judge yet.</li>}
      </ul>
      <div className="grid grid-cols-4 gap-1.5 text-center text-[10.5px] text-subtle">
        <div className="rounded-md bg-surface-2 py-1.5"><div className="tnum text-[13px] font-semibold text-fg">{m.activeMembers}/{m.members}</div>active</div>
        <div className="rounded-md bg-surface-2 py-1.5"><div className="tnum text-[13px] font-semibold text-fg">{m.medianHoursToContact == null ? '—' : `${Math.round(m.medianHoursToContact)}h`}</div>to contact</div>
        <div className="rounded-md bg-surface-2 py-1.5"><div className="tnum text-[13px] font-semibold text-fg">{m.purchases30d}</div>buys (30d)</div>
        <div className="rounded-md bg-surface-2 py-1.5"><div className="tnum flex items-center justify-center gap-0.5 text-[13px] font-semibold text-fg"><Coins className="size-3" />{fmtInt(m.credits)}</div>{m.creditDaysLeft != null ? `~${m.creditDaysLeft}d left` : 'credits'}</div>
      </div>
    </div>
  );
}
