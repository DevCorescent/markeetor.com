'use client';
import { ChevronDown, Gauge, Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PriceBreakdown } from '@/components/marketplace/company-preview';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/overlay';
import { InlineNotice } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { defaultDynamicPricing, INFO_ATTRIBUTES, money, type DynamicPricing, type PriceStep, type Pricing } from '@/lib/pricing';

export type Impact = {
  sampled: number; currency: string;
  current: { avg: number; min: number; max: number; total: number };
  proposed: { avg: number; min: number; max: number; total: number };
  coverage: Record<string, number>;
  examples: { ref: string; industry: string | null; ageDays: number; transfers: number; current: number; proposed: number; steps: PriceStep[] }[];
};

const PRESETS: { key: string; label: string; hint: string; apply: (d: DynamicPricing) => DynamicPricing }[] = [
  { key: 'balanced', label: 'Balanced', hint: 'Recommended defaults', apply: () => defaultDynamicPricing() },
  {
    key: 'premium', label: 'Reward rich data', hint: 'Bigger premiums for verified, researched leads',
    apply: (d) => ({ ...d, enabled: true, attributes: d.attributes.map((a) => ({ ...a, enabled: true, pct: Math.round((INFO_ATTRIBUTES.find((x) => x.key === a.key)?.pct ?? a.pct) * 1.8) })), research: { ...d.research, enabled: true, maxPct: 40 } }),
  },
  {
    key: 'clearance', label: 'Clear old stock', hint: 'Faster age and resale depreciation',
    apply: (d) => ({ ...d, enabled: true, age: { enabled: true, graceDays: 3, everyDays: 14, pct: 15, floorPct: 25 }, transfers: { enabled: true, pct: 25, floorPct: 20 } }),
  },
  {
    key: 'exclusive', label: 'Exclusive leads', hint: 'Steep drop once a lead has been sold',
    apply: (d) => ({ ...d, enabled: true, transfers: { enabled: true, pct: 50, floorPct: 15 } }),
  },
];

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

function Num({ value, onChange, min = 0, max = 100, step = 1, suffix, label, w = 'w-16' }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; label: string; w?: string }) {
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <Input type="number" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(clamp(Number(e.target.value), min, max))} className={cn('h-7 px-2 text-right text-[12.5px] tnum', w)} />
      {suffix && <span className="text-[12px] text-subtle">{suffix}</span>}
    </span>
  );
}

function Section({ title, hint, enabled, onToggle, children }: { title: string; hint: string; enabled?: boolean; onToggle?: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border">
      <header className="flex items-start justify-between gap-3 border-b border-border px-3.5 py-2.5">
        <div><div className="text-[13px] font-medium">{title}</div><div className="text-[11.5px] text-subtle">{hint}</div></div>
        {onToggle && <Switch checked={Boolean(enabled)} onCheckedChange={onToggle} aria-label={title} />}
      </header>
      <div className={cn('px-3.5 py-3', onToggle && !enabled && 'pointer-events-none opacity-45')}>{children}</div>
    </section>
  );
}

/** Compounding depreciation with a floor, as the engine applies it. */
const ageFactor = (a: DynamicPricing['age'], days: number) => (days <= a.graceDays ? 1 : Math.max(a.floorPct / 100, (1 - a.pct / 100) ** Math.ceil((days - a.graceDays) / a.everyDays)));
const resaleFactor = (t: DynamicPricing['transfers'], n: number) => (n <= 0 ? 1 : Math.max(t.floorPct / 100, (1 - t.pct / 100) ** n));

function Curve({ points, currency, base }: { points: { label: string; factor: number }[]; currency: string; base: number }) {
  return (
    <div className="mt-3 grid gap-1" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
      {points.map((pt) => (
        <div key={pt.label} className="flex flex-col items-center gap-1">
          <div className="flex h-14 w-full items-end justify-center rounded-sm bg-surface-2 px-1.5">
            <div className="w-full max-w-7 rounded-t-[3px] bg-fg/80" style={{ height: `${Math.max(4, pt.factor * 100)}%` }} />
          </div>
          <div className="tnum text-[11px] font-medium">{money(Math.round(base * pt.factor), currency)}</div>
          <div className="text-[10.5px] text-subtle">{pt.label}</div>
        </div>
      ))}
    </div>
  );
}

/** Super-admin control centre for information-, research-, age- and resale-based pricing. */
export function DynamicPricingCard({ p, set, impact }: { p: Pricing; set: (patch: Partial<Pricing>) => void; impact: Impact | null }) {
  const d = p.dynamic;
  const up = (patch: Partial<DynamicPricing>) => set({ dynamic: { ...d, ...patch } });
  const base = Math.round(p.basePrice * 100);
  const cov = (k: string) => (impact && impact.sampled ? Math.round(((impact.coverage[k] ?? 0) / impact.sampled) * 100) : null);
  const legacy = p.rules.filter((r) => r.enabled && r.conditions.some((c) => (c.field === 'ageDays' && d.age.enabled) || (c.field === 'distributionCount' && d.transfers.enabled)));
  const groups = [...new Set(INFO_ATTRIBUTES.map((a) => a.group))];
  const attr = (key: string) => d.attributes.find((a) => a.key === key);
  const setAttr = (key: (typeof INFO_ATTRIBUTES)[number]['key'], patch: { enabled?: boolean; pct?: number }) => {
    const exists = d.attributes.some((a) => a.key === key);
    const fallback = INFO_ATTRIBUTES.find((a) => a.key === key)!;
    up({ attributes: exists ? d.attributes.map((a) => (a.key === key ? { ...a, ...patch } : a)) : [...d.attributes, { key, enabled: true, pct: fallback.pct, ...patch }] });
  };
  const maxInfo = d.attributes.filter((a) => a.enabled && a.pct > 0).reduce((s, a) => s + a.pct, 0);

  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Gauge className="size-4" />Dynamic pricing</span>}
        description="Every lead is priced from the standard price by what it contains, how well it’s researched, how old it is and how often it has been sold."
        actions={<Switch checked={d.enabled} onCheckedChange={(v) => up({ enabled: v })} aria-label="Dynamic pricing" />}
      />
      <CardBody className={cn('flex flex-col gap-3', !d.enabled && 'opacity-50')}>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11.5px] text-subtle">Presets</span>
          {PRESETS.map((x) => (
            <button key={x.key} type="button" title={x.hint} disabled={!d.enabled} onClick={() => set({ dynamic: { ...x.apply(d), maxPrice: d.maxPrice, showBreakdown: d.showBreakdown } })} className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:border-border-strong hover:text-fg disabled:opacity-50">{x.label}</button>
          ))}
        </div>

        {legacy.length > 0 && <InlineNotice tone="warn">Pricing rule{legacy.length > 1 ? 's' : ''} {legacy.map((r) => `“${r.name}”`).join(', ')} also adjust{legacy.length > 1 ? '' : 's'} by age or times sold — both would apply. Disable {legacy.length > 1 ? 'them' : 'it'} below if dynamic pricing should handle it.</InlineNotice>}

        <Section title="1 · Information value" hint={`Each kind of information a lead has adds a % of the standard price (${money(base, p.currency)}). A lead with everything gets up to +${maxInfo}%.`}>
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 lg:grid-cols-2">
            {groups.map((g) => (
              <div key={g} className="flex flex-col">
                <div className="eyebrow mt-1 mb-1">{g}</div>
                {INFO_ATTRIBUTES.filter((a) => a.group === g).map((a) => {
                  const v = attr(a.key) ?? { enabled: false, pct: a.pct };
                  const c = cov(a.key);
                  return (
                    <div key={a.key} className="flex items-center gap-2.5 border-b border-border/60 py-1.5 last:border-0">
                      <Switch checked={v.enabled} onCheckedChange={(on) => setAttr(a.key, { enabled: on })} aria-label={a.label} />
                      <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', !v.enabled && 'text-subtle')}>{a.label}</span>
                      {c != null && <span className="tnum shrink-0 text-[10.5px] text-subtle" title="Share of available leads that have this">{c}% of leads</span>}
                      <span className={cn(!v.enabled && 'pointer-events-none opacity-40')}><Num label={`${a.label} %`} value={v.pct} min={-90} max={500} onChange={(pct) => setAttr(a.key, { pct })} suffix="%" w="w-14" /></span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </Section>

        <Section title="2 · Research quality" hint="Leads researched by AI (company profile, registry, website) are worth more — scaled by research confidence." enabled={d.research.enabled} onToggle={(v) => up({ research: { ...d.research, enabled: v } })}>
          <p className="text-[12.5px] leading-8 text-fg-2">
            Add up to <Num label="Research max %" value={d.research.maxPct} max={300} onChange={(v) => up({ research: { ...d.research, maxPct: v } })} suffix="%" /> for a fully confident profile, counting only research with at least <Num label="Minimum confidence" value={d.research.minConfidence} onChange={(v) => up({ research: { ...d.research, minConfidence: Math.round(v) } })} suffix="% confidence" />.
          </p>
          <p className="text-[11.5px] text-subtle">Example: 80% confidence → +{Math.round(d.research.maxPct * 0.8 * 10) / 10}%.{cov('researched') != null && ` ${cov('researched')}% of available leads are researched.`}</p>
        </Section>

        <Section title="3 · Lead age" hint="Older leads get cheaper step by step, but never below the floor." enabled={d.age.enabled} onToggle={(v) => up({ age: { ...d.age, enabled: v } })}>
          <p className="text-[12.5px] leading-8 text-fg-2">
            After <Num label="Grace days" value={d.age.graceDays} max={3650} onChange={(v) => up({ age: { ...d.age, graceDays: Math.round(v) } })} suffix="days" />, take off <Num label="Age %" value={d.age.pct} max={90} step={0.5} onChange={(v) => up({ age: { ...d.age, pct: v } })} suffix="%" /> every <Num label="Every days" value={d.age.everyDays} min={1} max={365} onChange={(v) => up({ age: { ...d.age, everyDays: Math.round(v) } })} suffix="days" />, never below <Num label="Age floor %" value={d.age.floorPct} onChange={(v) => up({ age: { ...d.age, floorPct: v } })} suffix="% of its price" />.
          </p>
          <Curve base={base} currency={p.currency} points={[0, 30, 60, 90, 180, 365].map((n) => ({ label: n === 0 ? 'New' : n < 365 ? `${n} d` : '1 yr', factor: ageFactor(d.age, n) }))} />
        </Section>

        <Section title="4 · Times sold" hint="Each time a lead is delivered to another client it loses value, down to a floor." enabled={d.transfers.enabled} onToggle={(v) => up({ transfers: { ...d.transfers, enabled: v } })}>
          <p className="text-[12.5px] leading-8 text-fg-2">
            Take off <Num label="Resale %" value={d.transfers.pct} max={90} step={0.5} onChange={(v) => up({ transfers: { ...d.transfers, pct: v } })} suffix="%" /> for every previous sale, never below <Num label="Resale floor %" value={d.transfers.floorPct} onChange={(v) => up({ transfers: { ...d.transfers, floorPct: v } })} suffix="% of its price" />.
          </p>
          <Curve base={base} currency={p.currency} points={[0, 1, 2, 3, 4, 5].map((n) => ({ label: n === 0 ? 'Never sold' : `${n}×`, factor: resaleFactor(d.transfers, n) }))} />
        </Section>

        <Section title="5 · Limits" hint="Hard bounds on every lead's final price. Clients only ever see the final price.">
          <div className="flex flex-col gap-2.5 text-[12.5px] text-fg-2">
            <p className="leading-8">Every lead costs at least the minimum price ({money(Math.round(p.minPrice * 100), p.currency)}, under Prices) and at most{' '}
              <label className="inline-flex items-center gap-1.5 align-middle"><Switch checked={d.maxPrice != null} onCheckedChange={(on) => up({ maxPrice: on ? Math.max(p.basePrice * 3, p.minPrice) : null })} aria-label="Maximum price" />{d.maxPrice != null ? <Num label="Maximum price" value={d.maxPrice} max={100000} step={0.5} w="w-20" onChange={(v) => up({ maxPrice: v })} suffix={p.currency} /> : <span className="text-subtle">no maximum</span>}</label>.
            </p>
          </div>
        </Section>
      </CardBody>
    </Card>
  );
}

/** Live re-pricing of the real catalog under the unsaved settings. */
export function useImpact(p: Pricing | null) {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = p ? JSON.stringify(p) : '';
  useEffect(() => {
    if (!key) return;
    let live = true;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api<Impact>('/api/v1/marketplace/pricing/preview', { body: JSON.parse(key) });
        if (live) { setImpact(r); setError(null); }
      } catch (e) {
        if (live) setError(errorMessage(e));
      } finally {
        if (live) setLoading(false);
      }
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [key]);
  return { impact, loading, error };
}

export function ImpactCard({ impact, loading, error, dirty }: { impact: Impact | null; loading: boolean; error: string | null; dirty: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <InlineNotice tone="warn">{error}</InlineNotice>;
  if (!impact) return null;
  const cur = impact.currency;
  const delta = impact.current.avg ? Math.round(((impact.proposed.avg - impact.current.avg) / impact.current.avg) * 1000) / 10 : 0;
  return (
    <Card>
      <CardHeader title="Catalog impact" description={`${impact.sampled.toLocaleString()} available leads re-priced${dirty ? ' with your unsaved changes' : ''}`} actions={loading ? <Loader2 className="size-4 animate-spin text-subtle" /> : undefined} />
      <CardBody className="flex flex-col gap-3">
        {impact.sampled === 0 ? <p className="text-[12.5px] text-muted">No leads are available in the marketplace right now.</p> : (
          <>
            <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border text-center">
              {[['Average', impact.proposed.avg], ['Lowest', impact.proposed.min], ['Highest', impact.proposed.max]].map(([k, v]) => (
                <div key={k as string} className="bg-surface px-2 py-2.5"><div className="text-[10.5px] text-subtle uppercase tracking-wide">{k}</div><div className="tnum text-[15px] font-semibold">{money(v as number, cur)}</div></div>
              ))}
            </div>
            {dirty && delta !== 0 && (
              <div className="flex items-center gap-2 text-[12px] text-muted">
                {delta > 0 ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
                Average {delta > 0 ? 'up' : 'down'} <b className="tnum text-fg">{Math.abs(delta)}%</b> from {money(impact.current.avg, cur)} · catalog value {money(impact.proposed.total, cur)}
              </div>
            )}
            <div>
              <div className="eyebrow mb-1.5">Example leads</div>
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                {impact.examples.map((x) => (
                  <li key={x.ref}>
                    <button type="button" onClick={() => setOpen(open === x.ref ? null : x.ref)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-surface-2">
                      <span className="font-mono text-[11px] text-subtle">{x.ref}</span>
                      <span className="min-w-0 flex-1 truncate text-fg-2">{x.industry ?? '—'} · {x.ageDays}d{x.transfers ? ` · sold ${x.transfers}×` : ''}</span>
                      {dirty && x.current !== x.proposed && <span className="tnum text-[11px] text-subtle line-through">{money(x.current, cur)}</span>}
                      <span className="tnum font-medium">{money(x.proposed, cur)}</span>
                      <ChevronDown className={cn('size-3.5 text-subtle transition-transform', open === x.ref && 'rotate-180')} />
                    </button>
                    {open === x.ref && <div className="px-3 pb-3"><PriceBreakdown steps={x.steps} total={x.proposed} currency={cur} title="Breakdown" /></div>}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
