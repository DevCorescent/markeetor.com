'use client';
import { ListFilter, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { OPS, type Condition, type FilterField } from '@/lib/filters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/overlay';

const NO_VALUE = new Set(['empty', 'not_empty', 'true', 'false']);

function describe(c: Condition, fields: FilterField[]) {
  const f = fields.find((x) => x.key === c.field);
  if (!f) return c.field;
  const op = OPS[f.type].find((o) => o.value === c.op)?.label ?? c.op;
  if (NO_VALUE.has(c.op)) return `${f.label} ${op}`;
  const v = Array.isArray(c.value) ? c.value.map((x) => f.options?.find((o) => o.value === x)?.label ?? x).join(', ') : String(c.value ?? '');
  return `${f.label} ${op} ${v}`;
}

/** Multi-condition filter builder. Conditions are AND-ed; the server validates every field and operator. */
export function FilterBuilder({ fields, value, onChange }: { fields: FilterField[]; value: Condition[]; onChange: (c: Condition[]) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Condition[]>(value);

  const update = (i: number, patch: Partial<Condition>) => setDraft((d) => d.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const add = () => {
    const f = fields[0];
    setDraft((d) => [...d, { field: f.key, op: OPS[f.type][0].value, value: f.type === 'enum' ? [] : '' }]);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setDraft(value.length ? value : []); }}>
        <PopoverTrigger asChild>
          <Button size="sm" variant={value.length ? 'outline' : 'ghost'}>
            <ListFilter /> Filter{value.length ? ` · ${value.length}` : ''}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(560px,calc(100vw-2rem))] p-3">
          <div className="mb-2 text-[11px] text-subtle">Show records where all conditions match</div>
          <div className="flex flex-col gap-2">
            {draft.length === 0 && <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-xs text-subtle">No conditions yet</div>}
            {draft.map((c, i) => {
              const f = fields.find((x) => x.key === c.field) ?? fields[0];
              return (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-start gap-1.5 max-sm:rounded-md max-sm:border max-sm:border-border max-sm:p-2 sm:grid-cols-[1fr_1fr_1.4fr_auto] [&>*:nth-child(3)]:max-sm:col-span-3">
                  <Select
                    aria-label="Field"
                    value={c.field}
                    onChange={(e) => {
                      const nf = fields.find((x) => x.key === e.target.value)!;
                      update(i, { field: nf.key, op: OPS[nf.type][0].value, value: nf.type === 'enum' ? [] : '' });
                    }}
                  >
                    {fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </Select>
                  <Select aria-label="Operator" value={c.op} onChange={(e) => update(i, { op: e.target.value })}>
                    {OPS[f.type].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                  {NO_VALUE.has(c.op) ? (
                    <div />
                  ) : f.type === 'enum' ? (
                    <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto rounded-md border border-border-strong bg-surface-2 p-1.5">
                      {f.options?.map((o) => {
                        const vals = Array.isArray(c.value) ? c.value : [];
                        const on = vals.includes(o.value);
                        return (
                          <button
                            key={o.value}
                            type="button"
                            onClick={() => update(i, { value: on ? vals.filter((v) => v !== o.value) : [...vals, o.value] })}
                            className={`rounded border px-1.5 py-0.5 text-[11px] ${on ? 'border-fg bg-fg text-inverse' : 'border-border-strong text-muted hover:text-fg'}`}
                          >
                            {o.label}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <Input
                      aria-label="Value"
                      type={f.type === 'number' || c.op.endsWith('_days') ? 'number' : f.type === 'date' ? 'date' : 'text'}
                      value={(c.value as string | number | null) ?? ''}
                      onChange={(e) => update(i, { value: f.type === 'number' || c.op.endsWith('_days') ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value })}
                    />
                  )}
                  <Button size="icon" variant="ghost" className="max-sm:col-start-3 max-sm:row-start-1" aria-label="Remove condition" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}><X /></Button>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <Button size="sm" variant="ghost" onClick={add}><Plus /> Add condition</Button>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => { setDraft([]); onChange([]); setOpen(false); }}>Clear</Button>
              <Button size="sm" variant="primary" onClick={() => { onChange(draft.filter((c) => NO_VALUE.has(c.op) || (Array.isArray(c.value) ? c.value.length : c.value !== '' && c.value != null))); setOpen(false); }}>Apply</Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {value.map((c, i) => (
        <Badge key={i} tone="neutral" className="h-6 gap-1.5 pr-1">
          <span className="max-w-[220px] truncate">{describe(c, fields)}</span>
          <button aria-label="Remove filter" className="rounded p-0.5 text-subtle hover:text-fg" onClick={() => onChange(value.filter((_, j) => j !== i))}><X className="size-3" /></button>
        </Badge>
      ))}
    </div>
  );
}
