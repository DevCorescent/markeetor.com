'use client';
import { cn } from '@/lib/cn';
import { fmtCompact, fmtInt, fmtPct } from '@/lib/format';

export type StageStat = { id: string; name: string; reached: number; current: number; value: number; avgScore: number; conversion: number; dropOff: number };
export type FunnelAnalysis = { total: number; stages: StageStat[]; overallConversion: number; bottleneck: { id: string; rate: number } | null };

/** Monochrome tapered funnel. Bar width = leads that reached the stage; the solid core = leads sitting in it now. */
export function FunnelChart({ analysis, selected, onSelect, loading }: { analysis: FunnelAnalysis; selected?: string | null; onSelect?: (id: string) => void; loading?: boolean }) {
  const max = Math.max(1, analysis.stages[0]?.reached ?? 0, analysis.total);
  const n = analysis.stages.length;
  return (
    <div className={cn('flex flex-col', loading && 'opacity-60 transition-opacity')}>
      {analysis.stages.map((s, i) => {
        const w = Math.max(6, (s.reached / max) * 100);
        const core = s.reached ? (s.current / s.reached) * 100 : 0;
        const isSel = selected === s.id;
        const isBottleneck = analysis.bottleneck?.id === s.id;
        const next = analysis.stages[i + 1];
        return (
          <div key={s.id}>
            <button type="button" onClick={() => onSelect?.(s.id)} aria-pressed={isSel}
              className={cn('group grid w-full grid-cols-[minmax(110px,22%)_1fr_minmax(92px,auto)] items-center gap-4 rounded-lg px-3 py-2 text-left transition-colors', onSelect && 'hover:bg-surface-2', isSel && 'bg-surface-2 ring-1 ring-border-strong')}>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[10.5px] text-subtle"><span className="tnum">{String(i + 1).padStart(2, '0')}</span>{isBottleneck && <span className="rounded bg-warn-dim px-1 text-[10px] font-medium text-warn">Biggest drop</span>}</div>
                <div className="truncate text-[13px] font-medium">{s.name}</div>
              </div>
              <div className="flex justify-center">
                <div className="relative h-10 overflow-hidden rounded-md bg-fg/12 transition-[width] duration-500 ease-out" style={{ width: `${w}%`, opacity: 1 - (i / Math.max(1, n)) * 0.35 }}>
                  <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 rounded-md bg-fg transition-[width] duration-500" style={{ width: `${core}%` }} />
                  <div className="absolute inset-0 flex items-center justify-center"><span className="tnum px-1.5 text-[12px] font-semibold text-white mix-blend-difference">{fmtInt(s.reached)}</span></div>
                </div>
              </div>
              <div className="text-right">
                <div className="tnum text-[13px] font-medium">{fmtInt(s.current)} <span className="text-[11px] font-normal text-subtle">here now</span></div>
                <div className="tnum text-[11px] text-subtle">{s.value ? `${fmtCompact(s.value)} value · ` : ''}score {s.avgScore || '—'}</div>
              </div>
            </button>
            {next && (
              <div className="grid grid-cols-[minmax(110px,22%)_1fr_minmax(92px,auto)] gap-4 px-3">
                <span />
                <div className="flex items-center justify-center gap-2 py-0.5 text-[11px] text-subtle">
                  <span className="h-3 w-px bg-border-strong" />
                  <span className="tnum"><b className="font-medium text-fg-2">{fmtPct(next.conversion, 0)}</b> continue · {fmtInt(s.dropOff)} stop here</span>
                  <span className="h-3 w-px bg-border-strong" />
                </div>
                <span />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Small funnel silhouette for cards. */
export function MiniFunnel({ analysis }: { analysis: FunnelAnalysis }) {
  const max = Math.max(1, analysis.stages[0]?.reached ?? 0);
  return (
    <div className="flex flex-col items-center gap-[3px]">
      {analysis.stages.map((s, i) => (
        <div key={s.id} className="h-2.5 rounded-sm bg-fg transition-[width]" style={{ width: `${Math.max(4, (s.reached / max) * 100)}%`, opacity: 0.85 - (i / analysis.stages.length) * 0.55 }} title={`${s.name}: ${fmtInt(s.reached)}`} />
      ))}
    </div>
  );
}
