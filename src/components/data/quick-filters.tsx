'use client';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/overlay';
import type { Condition } from '@/lib/filters';
import { cn } from '@/lib/cn';

export type Facets = { sources: string[]; campaigns: string[]; industries: string[]; countries: string[]; tags: { id: string; name: string }[]; orgs: { id: string; name: string; status: string }[]; imports: { id: string; code: string; fileName: string }[] };

/** Returns the condition for a field (and op, for range fields). */
export const findCond = (cs: Condition[], field: string, op?: string) => cs.find((c) => c.field === field && (!op || c.op === op));

/** Replaces the condition(s) for a field (+op) — or removes them when `next` is null. */
export function setCond(cs: Condition[], field: string, next: Condition | null, op?: string): Condition[] {
  const rest = cs.filter((c) => !(c.field === field && (!op || c.op === op)));
  return next ? [...rest, next] : rest;
}

const asList = (v: Condition['value']) => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]);

/** Pill-style multi-select filter (popover with search + checkboxes). */
export function MultiFilter({ label, options, conditions, field, onChange, negatable }: {
  label: string; options: { value: string; label: string }[]; conditions: Condition[]; field: string; onChange: (c: Condition[]) => void; negatable?: boolean;
}) {
  const [q, setQ] = useState('');
  const cur = findCond(conditions, field);
  const values = asList(cur?.value);
  const exclude = cur?.op === 'not_in';
  const set = (vals: string[], ex = exclude) => onChange(setCond(conditions, field, vals.length ? { field, op: ex ? 'not_in' : 'in', value: vals } : null));
  const shown = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
  const summary = values.length === 0 ? null : values.length === 1 ? (options.find((o) => o.value === values[0])?.label ?? values[0]) : `${values.length} selected`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn('flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors', values.length ? 'border-fg bg-surface-3 text-fg' : 'border-border-strong text-muted hover:text-fg')}>
          {label}{summary && <span className="max-w-[140px] truncate font-medium">{exclude ? 'not ' : ': '}{summary}</span>}
          {values.length ? <X className="size-3 text-subtle hover:text-fg" onClick={(e) => { e.stopPropagation(); set([]); }} /> : <ChevronDown className="size-3 text-subtle" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        {options.length > 8 && <div className="relative mb-1.5"><Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-subtle" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}`} className="h-7 pl-7 text-[12px]" /></div>}
        {negatable && (
          <div className="mb-1 flex gap-1 rounded-md bg-surface-3 p-0.5 text-[11px]">
            {[false, true].map((ex) => <button key={String(ex)} type="button" onClick={() => set(values, ex)} className={cn('flex-1 rounded px-2 py-1', exclude === ex ? 'bg-surface text-fg shadow-[var(--card-shadow)]' : 'text-subtle')}>{ex ? 'Exclude' : 'Include'}</button>)}
          </div>
        )}
        <div className="max-h-64 overflow-y-auto">
          {shown.map((o) => {
            const on = values.includes(o.value);
            return (
              <button key={o.value} type="button" onClick={() => set(on ? values.filter((v) => v !== o.value) : [...values, o.value])} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-surface-3">
                <span className={cn('grid size-3.5 place-items-center rounded-[3px] border', on ? 'border-fg bg-fg text-inverse' : 'border-faint')}>{on && <Check className="size-2.5" strokeWidth={3} />}</span>
                <span className="truncate">{o.label}</span>
              </button>
            );
          })}
          {!shown.length && <div className="px-2 py-1.5 text-[11.5px] text-subtle">No options</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Numeric range pill (min / max) for a number field. */
export function RangeFilter({ label, field, conditions, onChange, placeholder = ['0', '100'] }: { label: string; field: string; conditions: Condition[]; onChange: (c: Condition[]) => void; placeholder?: [string, string] }) {
  const min = findCond(conditions, field, 'gte')?.value;
  const max = findCond(conditions, field, 'lte')?.value;
  const active = min != null || max != null;
  const upd = (op: 'gte' | 'lte', v: string) => onChange(setCond(conditions, field, v === '' ? null : { field, op, value: Number(v) }, op));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn('flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px]', active ? 'border-fg bg-surface-3 text-fg' : 'border-border-strong text-muted hover:text-fg')}>
          {label}{active && <span className="font-medium">: {min ?? '…'}–{max ?? '…'}</span>}
          {active ? <X className="size-3 text-subtle hover:text-fg" onClick={(e) => { e.stopPropagation(); onChange(setCond(setCond(conditions, field, null, 'gte'), field, null, 'lte')); }} /> : <ChevronDown className="size-3 text-subtle" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-3">
        <div className="flex items-center gap-2">
          <Input type="number" placeholder={placeholder[0]} value={min == null ? '' : String(min)} onChange={(e) => upd('gte', e.target.value)} className="h-8" aria-label={`Minimum ${label}`} />
          <span className="text-subtle">–</span>
          <Input type="number" placeholder={placeholder[1]} value={max == null ? '' : String(max)} onChange={(e) => upd('lte', e.target.value)} className="h-8" aria-label={`Maximum ${label}`} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** "Times distributed" segmented pill: any / never / once / 2+. */
export function TimesFilter({ conditions, onChange }: { conditions: Condition[]; onChange: (c: Condition[]) => void }) {
  const eq = findCond(conditions, 'distributionCount', 'eq')?.value;
  const gte = findCond(conditions, 'distributionCount', 'gte')?.value;
  const cur = eq === 0 ? 'never' : eq === 1 ? 'once' : gte === 2 ? 'multi' : gte === 1 ? 'any_prev' : 'any';
  const set = (k: string) => {
    let cs = setCond(setCond(conditions, 'distributionCount', null, 'eq'), 'distributionCount', null, 'gte');
    if (k === 'never') cs = [...cs, { field: 'distributionCount', op: 'eq', value: 0 }];
    if (k === 'once') cs = [...cs, { field: 'distributionCount', op: 'eq', value: 1 }];
    if (k === 'multi') cs = [...cs, { field: 'distributionCount', op: 'gte', value: 2 }];
    if (k === 'any_prev') cs = [...cs, { field: 'distributionCount', op: 'gte', value: 1 }];
    onChange(cs);
  };
  const opts: [string, string][] = [['any', 'Any'], ['never', 'Never'], ['any_prev', 'Before'], ['once', '1×'], ['multi', '2×+']];
  return (
    <div className="flex h-7 items-center rounded-md border border-border-strong p-0.5 text-[11.5px]" role="radiogroup" aria-label="Times distributed">
      <span className="px-1.5 text-subtle">Distributed</span>
      {opts.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={cur === k} onClick={() => set(k)} className={cn('h-full rounded px-2', cur === k ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{l}</button>)}
    </div>
  );
}
