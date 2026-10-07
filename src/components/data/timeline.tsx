import { cn } from '@/lib/cn';
import { fmtAgo, fmtDateTime } from '@/lib/format';

export type TimelineItem = {
  id: string;
  title: React.ReactNode;
  body?: React.ReactNode;
  at: string | Date;
  actor?: string | null;
  badge?: React.ReactNode;
  verification?: 'SYSTEM_VERIFIED' | 'SELF_REPORTED' | 'PROVIDER_VERIFIED';
};

const V_LABEL = { SYSTEM_VERIFIED: 'System recorded', SELF_REPORTED: 'Self-reported', PROVIDER_VERIFIED: 'Provider verified' } as const;

/** Audit/activity timeline. Self-reported events are visually distinct from system-recorded ones. */
export function Timeline({ items, className, empty = 'No activity yet' }: { items: TimelineItem[]; className?: string; empty?: string }) {
  if (!items.length) return <div className="py-8 text-center text-xs text-subtle">{empty}</div>;
  return (
    <ol className={cn('relative', className)}>
      {items.map((it, i) => (
        <li key={it.id} className="relative flex gap-3 pb-4 last:pb-0">
          {i < items.length - 1 && <span className="absolute top-3 bottom-0 left-[3.5px] w-px bg-border" aria-hidden />}
          <span
            className={cn('mt-[5px] size-2 shrink-0 rounded-full border', it.verification === 'SELF_REPORTED' ? 'border-muted bg-transparent' : 'border-fg bg-fg')}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[12.5px] text-fg">{it.title}</span>
              {it.badge}
              {it.verification && <span className="text-[10.5px] text-subtle">· {V_LABEL[it.verification]}</span>}
            </div>
            {it.body && <div className="mt-1 text-xs leading-relaxed whitespace-pre-wrap text-muted">{it.body}</div>}
            <div className="mt-0.5 text-[11px] text-subtle" title={fmtDateTime(it.at)}>
              {it.actor ? `${it.actor} · ` : ''}{fmtAgo(it.at)}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
