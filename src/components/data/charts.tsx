'use client';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cn } from '@/lib/cn';
import { fmtInt } from '@/lib/format';

/**
 * Monochrome chart system. Identity is never carried by colour alone: multi-series charts use
 * distinct stroke patterns (solid / dashed / dotted) plus a legend; categorical rankings are
 * rendered as labelled HTML bars.
 */
export const SERIES_STYLES = [
  { stroke: 'var(--chart-1)', dash: undefined },
  { stroke: 'var(--chart-2)', dash: '5 4' },
  { stroke: 'var(--chart-3)', dash: '2 3' },
  { stroke: 'var(--chart-5)', dash: '9 3 2 3' },
] as const;

type Series = { key: string; label: string };

function ChartTooltip({ active, payload, label, series, formatter }: { active?: boolean; payload?: { dataKey: string; value: number }[]; label?: string; series: Series[]; formatter?: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border-strong bg-surface-2 px-2.5 py-2 text-[11.5px] shadow-xl">
      <div className="mb-1 text-subtle">{label && /^\d{4}-\d{2}-\d{2}$/.test(String(label)) ? tickDate(String(label)) : label}</div>
      {series.map((s, i) => {
        const p = payload.find((x) => x.dataKey === s.key);
        if (!p) return null;
        return (
          <div key={s.key} className="flex items-center gap-2">
            <svg width="16" height="6" aria-hidden><line x1="0" y1="3" x2="16" y2="3" stroke={SERIES_STYLES[i].stroke} strokeWidth="2" strokeDasharray={SERIES_STYLES[i].dash} /></svg>
            <span className="text-muted">{s.label}</span>
            <span className="tnum ml-auto pl-3 text-fg">{formatter ? formatter(p.value) : fmtInt(p.value)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
      {series.map((s, i) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke={SERIES_STYLES[i].stroke} strokeWidth="2" strokeDasharray={SERIES_STYLES[i].dash} /></svg>
          {s.label}
        </span>
      ))}
    </div>
  );
}

const tickDate = (v: string) => {
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

export function TrendChart({ data, series, height = 220, xKey = 'day', area, formatter }: { data: Record<string, unknown>[]; series: Series[]; height?: number; xKey?: string; area?: boolean; formatter?: (v: number) => string }) {
  const empty = data.every((d) => series.every((s) => !Number(d[s.key])));
  return (
    <div className="flex flex-col gap-2">
      <Legend series={series} />
      <div style={{ height }} className="relative" role="img" aria-label={`Trend of ${series.map((s) => s.label).join(', ')}`}>
        {empty && <div className="absolute inset-0 z-10 grid place-items-center text-xs text-subtle">No activity in this period</div>}
        <ResponsiveContainer width="100%" height="100%">
          {area && series.length === 1 ? (
            <AreaChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="fadeFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.14} />
                  <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="0" />
              <XAxis dataKey={xKey} tickFormatter={tickDate} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={44} />
              <Tooltip content={<ChartTooltip series={series} formatter={formatter} />} cursor={{ stroke: 'var(--faint)' }} />
              <Area type="monotone" dataKey={series[0].key} stroke="var(--chart-1)" strokeWidth={2} fill="url(#fadeFill)" isAnimationActive={false} />
            </AreaChart>
          ) : (
            <LineChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey={xKey} tickFormatter={tickDate} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={44} />
              <Tooltip content={<ChartTooltip series={series} formatter={formatter} />} cursor={{ stroke: 'var(--faint)' }} />
              {series.map((s, i) => (
                <Line key={s.key} type="monotone" dataKey={s.key} stroke={SERIES_STYLES[i].stroke} strokeDasharray={SERIES_STYLES[i].dash} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: 'var(--bg)', strokeWidth: 2 }} isAnimationActive={false} />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function ColumnChart({ data, xKey, yKey, label, height = 200, formatter }: { data: Record<string, unknown>[]; xKey: string; yKey: string; label: string; height?: number; formatter?: (v: number) => string }) {
  return (
    <div style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }} barCategoryGap={6}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey={xKey} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={12} tickFormatter={(v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? tickDate(String(v)) : String(v).slice(0, 14))} />
          <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={44} />
          <Tooltip content={<ChartTooltip series={[{ key: yKey, label }]} formatter={formatter} />} cursor={{ fill: 'var(--chart-cursor)' }} />
          <Bar dataKey={yKey} fill="var(--chart-bar)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Ranked horizontal bars in HTML: labels stay legible, values are always printed. */
export function BarList({ items, format = fmtInt, empty = 'No data', max: maxProp, onSelect }: { items: { label: string; value: number; sub?: string; href?: string }[]; format?: (n: number) => string; empty?: string; max?: number; onSelect?: (label: string) => void }) {
  if (!items.length) return <div className="py-6 text-center text-xs text-subtle">{empty}</div>;
  const max = maxProp ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="flex flex-col gap-2">
      {items.map((it) => {
        const row = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="truncate text-fg-2">{it.label}</span>
              <span className="tnum shrink-0 text-fg">{format(it.value)}{it.sub && <span className="ml-1.5 text-subtle">{it.sub}</span>}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-fg/85" style={{ width: `${Math.max(0.5, (it.value / max) * 100)}%` }} />
            </div>
          </>
        );
        return (
          <li key={it.label}>
            {onSelect ? <button className="block w-full text-left hover:opacity-80" onClick={() => onSelect(it.label)}>{row}</button> : row}
          </li>
        );
      })}
    </ul>
  );
}

/** Conversion funnel: stepped bars with step-to-step and overall conversion. */
export function Funnel({ steps }: { steps: { stage: string; value: number }[] }) {
  const top = Math.max(1, steps[0]?.value ?? 0);
  return (
    <ol className="flex flex-col gap-1.5">
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1].value : null;
        const step = prev ? s.value / prev : null;
        return (
          <li key={s.stage} className="grid grid-cols-[96px_1fr_88px] items-center gap-3 text-[12px]">
            <span className="truncate capitalize text-muted">{s.stage}</span>
            <div className="h-6 overflow-hidden rounded-[4px] bg-surface-3">
              <div className={cn('flex h-full items-center rounded-[4px] px-2', i === steps.length - 1 ? 'bg-fg' : 'bg-fg/70')} style={{ width: `${Math.max(1.5, (s.value / top) * 100)}%` }} />
            </div>
            <span className="tnum text-right text-fg">
              {fmtInt(s.value)}
              <span className="ml-1.5 text-[10.5px] text-subtle">{step != null ? `${(step * 100).toFixed(0)}%` : ''}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Small horizontal meter for utilisation / rates. */
export function Meter({ value, className }: { value: number | null; className?: string }) {
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-3"><div className={cn('h-full rounded-full', v >= 0.9 ? 'bg-warn' : 'bg-fg/80')} style={{ width: `${v * 100}%` }} /></div>
      <span className="tnum text-[11.5px] text-muted">{value == null ? '—' : `${(v * 100).toFixed(0)}%`}</span>
    </div>
  );
}
