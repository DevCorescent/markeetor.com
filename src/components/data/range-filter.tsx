'use client';
import { Bookmark, CalendarRange, ChevronDown, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api-client';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox, Popover, PopoverContent, PopoverTrigger } from '@/components/ui/overlay';

export type RangeState = { range: string; from?: string; to?: string; orgs?: string; sources?: string; campaigns?: string };

const PRESETS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'custom', label: 'Custom' },
];

export function rangeToQuery(s: RangeState) {
  const sp = new URLSearchParams();
  if (s.range === 'custom') {
    if (s.from) sp.set('from', s.from);
    if (s.to) sp.set('to', s.to);
  } else {
    sp.set('from', new Date(Date.now() - Number(s.range || 30) * 86400_000).toISOString().slice(0, 10));
  }
  for (const k of ['orgs', 'sources', 'campaigns'] as const) {
    const key = k === 'orgs' ? 'orgIds' : k;
    s[k]?.split('|').filter(Boolean).forEach((v) => sp.append(key, v));
  }
  return sp.toString();
}

function MultiPick({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const filtered = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant={value.length ? 'outline' : 'ghost'}>
          {label}{value.length ? ` · ${value.length}` : ''} <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        <Input placeholder={`Filter ${label.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} className="mb-1.5 h-7" />
        <div className="max-h-64 overflow-y-auto">
          {filtered.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12.5px] hover:bg-surface-3">
              <Checkbox checked={value.includes(o.value)} onCheckedChange={(c) => onChange(c ? [...value, o.value] : value.filter((v) => v !== o.value))} aria-label={o.label} />
              <span className="truncate">{o.label}</span>
            </label>
          ))}
          {!filtered.length && <div className="px-2 py-3 text-xs text-subtle">No options</div>}
        </div>
        {value.length > 0 && <button className="mt-1 w-full rounded px-2 py-1.5 text-left text-xs text-subtle hover:text-fg" onClick={() => onChange([])}>Clear</button>}
      </PopoverContent>
    </Popover>
  );
}

/** One row of filters above the charts: date range, client, source, campaign, and saved filter sets. */
export function RangeFilter({ state, onChange, facets, savedScope }: {
  state: RangeState;
  onChange: (s: Partial<RangeState>) => void;
  facets?: { orgs?: { id: string; name: string }[]; sources?: string[]; campaigns?: string[] };
  savedScope?: 'ADMIN_DASHBOARD';
}) {
  const split = (v?: string) => v?.split('|').filter(Boolean) ?? [];
  const views = useApiQuery<{ views: { id: string; name: string; state: RangeState }[] }>(savedScope ? `/api/v1/views?scope=${savedScope}` : null);
  const save = useApiMutation((name: string) => api('/api/v1/views', { body: { scope: savedScope, name, state } }), { success: 'Filters saved', invalidate: ['/api/v1/views'] });
  const del = useApiMutation((id: string) => api(`/api/v1/views/${id}`, { method: 'DELETE' }), { invalidate: ['/api/v1/views'] });
  const [name, setName] = useState('');
  const active = split(state.orgs).length + split(state.sources).length + split(state.campaigns).length;

  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5">
      <div className="flex items-center rounded-md border border-border bg-surface p-0.5" role="group" aria-label="Date range">
        <CalendarRange className="mx-1.5 size-3.5 text-subtle" />
        {PRESETS.map((p) => (
          <button
            key={p.value}
            onClick={() => onChange({ range: p.value })}
            aria-pressed={state.range === p.value}
            className={`h-6 rounded px-2 text-[11.5px] transition-colors ${state.range === p.value ? 'bg-fg text-inverse' : 'text-muted hover:text-fg'}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {state.range === 'custom' && (
        <div className="flex items-center gap-1">
          <Input type="date" className="h-7 w-[140px]" value={state.from ?? ''} onChange={(e) => onChange({ from: e.target.value })} aria-label="From" />
          <span className="text-subtle">–</span>
          <Input type="date" className="h-7 w-[140px]" value={state.to ?? ''} onChange={(e) => onChange({ to: e.target.value })} aria-label="To" />
        </div>
      )}
      {facets?.orgs && <MultiPick label="Clients" options={facets.orgs.map((o) => ({ value: o.id, label: o.name }))} value={split(state.orgs)} onChange={(v) => onChange({ orgs: v.join('|') })} />}
      {facets?.sources && <MultiPick label="Sources" options={facets.sources.map((s) => ({ value: s, label: s }))} value={split(state.sources)} onChange={(v) => onChange({ sources: v.join('|') })} />}
      {facets?.campaigns && <MultiPick label="Campaigns" options={facets.campaigns.map((s) => ({ value: s, label: s }))} value={split(state.campaigns)} onChange={(v) => onChange({ campaigns: v.join('|') })} />}
      {active > 0 && <Button size="sm" variant="ghost" onClick={() => onChange({ orgs: '', sources: '', campaigns: '' })}><X /> Reset</Button>}
      {savedScope && (
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className="ml-auto"><Bookmark /> Saved filters</Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-2">
            <div className="mb-2 flex flex-col gap-0.5">
              {views.data?.views.length ? views.data.views.map((v) => (
                <div key={v.id} className="flex items-center gap-1 rounded hover:bg-surface-3">
                  <button className="flex-1 truncate px-2 py-1.5 text-left text-[12.5px]" onClick={() => onChange({ from: '', to: '', orgs: '', sources: '', campaigns: '', ...v.state })}>{v.name}</button>
                  <button className="p-1.5 text-subtle hover:text-fg" aria-label={`Delete ${v.name}`} onClick={() => del.mutate(v.id)}><X className="size-3" /></button>
                </div>
              )) : <div className="px-2 py-2 text-xs text-subtle">No saved filters yet</div>}
            </div>
            <form className="flex gap-1 border-t border-border pt-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate(name.trim()); setName(''); }}>
              <Input placeholder="Save current as…" value={name} onChange={(e) => setName(e.target.value)} className="h-7" />
              <Button size="sm" type="submit" disabled={!name.trim()}>Save</Button>
            </form>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
