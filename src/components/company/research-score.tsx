'use client';
import { Tooltip } from '@/components/ui/overlay';
import { cn } from '@/lib/cn';
import { fmtAgo } from '@/lib/format';

/** How well a lead's company has been researched: 0–100 confidence that the profile belongs to this company. */
export type ResearchInfo = { score: number; status: 'DONE' | 'PARTIAL' | string; researchedAt: string | Date | null } | null;

export const researchLabel = (score: number) => (score >= 80 ? 'Strong' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Low');

export function ResearchScore({ r, size = 'sm', className }: { r: ResearchInfo | undefined; size?: 'sm' | 'lg'; className?: string }) {
  if (!r) {
    return (
      <Tooltip content="This company hasn’t been researched yet">
        <span className={cn('text-[11.5px] text-subtle', className)}>Not researched</span>
      </Tooltip>
    );
  }
  const label = researchLabel(r.score);
  const tip = (
    <span className="block max-w-[220px] text-[11.5px] leading-snug">
      <b>Research score {r.score}/100 · {label}</b>
      <span className="block opacity-80">How confident the AI research is that the company profile is accurate{r.status === 'PARTIAL' ? ' (no public website was found, so only basic checks ran)' : ''}.{r.researchedAt ? ` Researched ${fmtAgo(r.researchedAt)}.` : ''}</span>
    </span>
  );
  if (size === 'lg') {
    return (
      <Tooltip content={tip}>
        <span className={cn('inline-flex items-center gap-2.5 rounded-md border border-border px-2.5 py-1.5', className)}>
          <span className="tnum text-[18px] leading-none font-semibold tracking-[-0.02em]">{r.score}</span>
          <span className="flex flex-col gap-1">
            <span className="text-[10.5px] leading-none tracking-wide text-subtle uppercase">Research · {label}</span>
            <span className="h-1 w-20 rounded-full bg-surface-3"><span className="block h-full rounded-full bg-fg" style={{ width: `${Math.min(100, r.score)}%` }} /></span>
          </span>
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={tip}>
      <span className={cn('inline-flex w-24 items-center gap-2', className)}>
        <span className="h-1.5 flex-1 rounded-full bg-surface-3"><span className={cn('block h-full rounded-full', r.score >= 60 ? 'bg-fg' : 'bg-fg/45')} style={{ width: `${Math.min(100, r.score)}%` }} /></span>
        <span className="tnum w-6 text-right text-[11.5px]">{r.score}</span>
      </span>
    </Tooltip>
  );
}
