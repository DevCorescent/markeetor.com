'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, BellRing, Bookmark, Check, Columns3, Mail, Pencil, Play, Search, ShoppingCart, Star, Trash2, X, Zap } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Dialog, Switch } from '@/components/ui/overlay';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import type { Condition } from '@/lib/filters';
import { fmtAgo, fmtInt, humanize } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { money } from '@/lib/pricing';
import { researchLabel } from '@/components/company/research-score';
import type { MarketRow } from './company-preview';

export type SavedSearch = {
  id: string; name: string; filter: { conditions: Condition[] }; alertInApp: boolean; alertEmail: boolean; autoBuy: boolean; autoBuyMaxPerWeek: number; autoBuyMaxPrice: number | null;
  active: boolean; lastCheckedAt: string | null; lastAlertAt: string | null; lastAutoBuyAt: string | null; totalAutoBought: number; matches: number; newMatches: number; createdAt: string;
};
type Limits = { max: number; autoBuyEnabled: boolean; maxAutoBuyPerWeek: number };

const FIELD_LABEL: Record<string, string> = { country: 'Country', state: 'State', industry: 'Industry', source: 'Source', campaign: 'Campaign', priority: 'Priority', score: 'Score', createdAt: 'Added', distributionCount: 'Fresh', keyword: 'Business', enrichment: 'Profile' };

/** "Industry: Solar, Retail · Score ≥ 60 · Last 7 days" */
export function describeFilter(cs: Condition[]) {
  if (!cs.length) return 'All available leads';
  return cs.map((c) => {
    const label = FIELD_LABEL[c.field] ?? humanize(c.field);
    if (c.field === 'distributionCount') return 'Fresh only';
    if (c.field === 'enrichment') return 'With company profile';
    if (c.field === 'createdAt' && c.op === 'last_days') return `Added in last ${c.value} days`;
    if (c.op === 'gte') return `${label} ≥ ${c.value}`;
    if (c.op === 'lte') return `${label} ≤ ${c.value}`;
    const v = Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '');
    return `${label}${c.op === 'not_in' ? ' not' : ''}: ${v}`;
  }).join(' · ');
}

const invalidate = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/marketplace') });

type Draft = { name: string; alertInApp: boolean; alertEmail: boolean; autoBuy: boolean; autoBuyMaxPerWeek: number; autoBuyMaxPrice: number | null; active: boolean };

export function SaveSearchDialog({ conditions, existing, canBuy, currency, onClose, onSaved }: { conditions: Condition[]; existing?: SavedSearch | null; canBuy: boolean; currency: string; onClose: () => void; onSaved?: (s: SavedSearch) => void }) {
  const qc = useQueryClient();
  const limits = useApiQuery<{ limits: Limits }>('/api/v1/marketplace/searches');
  const [d, setD] = useState<Draft>(existing ? { name: existing.name, alertInApp: existing.alertInApp, alertEmail: existing.alertEmail, autoBuy: existing.autoBuy, autoBuyMaxPerWeek: existing.autoBuyMaxPerWeek, autoBuyMaxPrice: existing.autoBuyMaxPrice, active: existing.active } : { name: describeFilter(conditions).slice(0, 60), alertInApp: true, alertEmail: false, autoBuy: false, autoBuyMaxPerWeek: 10, autoBuyMaxPrice: null, active: true });
  const [busy, setBusy] = useState(false);
  const l = limits.data?.limits;
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...d, filter: { conditions: existing ? existing.filter.conditions : conditions } };
      const s = await api<SavedSearch>(existing ? `/api/v1/marketplace/searches/${existing.id}` : '/api/v1/marketplace/searches', { method: existing ? 'PUT' : 'POST', body });
      toast.success(existing ? 'Saved search updated' : 'Search saved', { description: d.autoBuy ? 'New matches will be bought automatically with credits.' : 'We’ll let you know when new matching leads arrive.' });
      await invalidate(qc);
      onSaved?.(s);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={existing ? 'Edit saved search' : 'Save this search'} description={describeFilter(existing ? existing.filter.conditions : conditions)}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!d.name.trim()} onClick={save}>{existing ? 'Save changes' : 'Save search'}</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Name"><Input value={d.name} maxLength={80} onChange={(e) => setD({ ...d, name: e.target.value })} autoFocus /></Field>
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div className="eyebrow">When new leads match</div>
          <label className="flex items-center justify-between gap-3 text-[12.5px]"><span className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-md bg-info-dim text-info"><Bell className="size-3.5" /></span>Notify me in the app</span><Switch checked={d.alertInApp} onCheckedChange={(v) => setD({ ...d, alertInApp: v })} aria-label="In-app alerts" /></label>
          <label className="flex items-center justify-between gap-3 text-[12.5px]"><span className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-md bg-accent-dim text-accent"><Mail className="size-3.5" /></span>Email me</span><Switch checked={d.alertEmail} onCheckedChange={(v) => setD({ ...d, alertEmail: v })} aria-label="Email alerts" /></label>
        </div>
        {canBuy && l?.autoBuyEnabled !== false && (
          <div className={cn('flex flex-col gap-3 rounded-lg border p-3', d.autoBuy ? 'border-ok/30 bg-ok-dim/40' : 'border-border')}>
            <label className="flex items-center justify-between gap-3 text-[12.5px]">
              <span className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-md bg-ok-dim text-ok"><Zap className="size-3.5" /></span><span><b className="font-medium">Auto-buy new matches</b><span className="block text-[11.5px] text-subtle">Paid with credits, delivered straight to My leads.</span></span></span>
              <Switch checked={d.autoBuy} onCheckedChange={(v) => setD({ ...d, autoBuy: v })} aria-label="Auto-buy" />
            </label>
            {d.autoBuy && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Max leads per week" hint={l ? `Up to ${fmtInt(l.maxAutoBuyPerWeek)}` : undefined}><Input type="number" min={1} max={l?.maxAutoBuyPerWeek ?? 5000} value={d.autoBuyMaxPerWeek} onChange={(e) => setD({ ...d, autoBuyMaxPerWeek: Math.max(1, Math.round(Number(e.target.value))) })} /></Field>
                <Field label={`Max price per lead (${currency})`} hint="Leave empty for any price"><Input type="number" min={0} step={0.5} value={d.autoBuyMaxPrice ?? ''} onChange={(e) => setD({ ...d, autoBuyMaxPrice: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} /></Field>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function SavedSearches({ canBuy, currency, onApply }: { canBuy: boolean; currency: string; onApply: (s: SavedSearch) => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useApiQuery<{ rows: SavedSearch[]; limits: Limits }>('/api/v1/marketplace/searches', { refetchInterval: 60_000 });
  const [edit, setEdit] = useState<SavedSearch | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<unknown>, msg?: string) => {
    setBusy(key);
    try { await fn(); if (msg) toast.success(msg); await invalidate(qc); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  if (isLoading || !data) return <Skeleton className="h-48" />;
  const toggle = (s: SavedSearch, patch: Partial<SavedSearch>) => act(`${s.id}-t`, () => api(`/api/v1/marketplace/searches/${s.id}`, { method: 'PUT', body: { name: s.name, filter: s.filter, alertInApp: s.alertInApp, alertEmail: s.alertEmail, autoBuy: s.autoBuy, autoBuyMaxPerWeek: s.autoBuyMaxPerWeek, autoBuyMaxPrice: s.autoBuyMaxPrice, active: s.active, ...patch } }));
  if (!data.rows.length) {
    return (
      <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span className="grid size-12 place-items-center rounded-xl bg-info-dim text-info"><BellRing className="size-5" /></span>
        <div className="text-[14px] font-medium">No saved searches yet</div>
        <p className="max-w-md text-[12.5px] text-muted">Set filters on Browse leads and click <b className="font-medium text-fg">Save search</b>. We’ll alert you when new matching leads arrive — or buy them for you automatically.</p>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {data.rows.map((s) => (
        <Card key={s.id} className={cn('flex flex-col gap-3 p-4', !s.active && 'opacity-60')}>
          <div className="flex items-start gap-3">
            <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', s.autoBuy ? 'bg-ok-dim text-ok' : 'bg-info-dim text-info')}>{s.autoBuy ? <Zap className="size-4" /> : <Bookmark className="size-4" />}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2"><span className="truncate text-[14px] font-medium">{s.name}</span>{s.newMatches > 0 && <span className="rounded-full bg-info px-2 py-0.5 text-[10.5px] font-semibold text-white">{fmtInt(s.newMatches)} new</span>}</div>
              <div className="mt-0.5 line-clamp-2 text-[11.5px] text-subtle">{describeFilter(s.filter.conditions)}</div>
            </div>
            <Switch checked={s.active} onCheckedChange={(v) => toggle(s, { active: v })} aria-label="Active" />
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-md bg-surface-2 px-2 py-1.5"><div className="tnum text-[16px] font-semibold">{fmtInt(s.matches)}</div><div className="text-[10.5px] text-subtle">matching now</div></div>
            <div className="rounded-md bg-surface-2 px-2 py-1.5"><div className="tnum text-[16px] font-semibold text-info">{fmtInt(s.newMatches)}</div><div className="text-[10.5px] text-subtle">new since check</div></div>
            <div className="rounded-md bg-surface-2 px-2 py-1.5"><div className="tnum text-[16px] font-semibold text-ok">{fmtInt(s.totalAutoBought)}</div><div className="text-[10.5px] text-subtle">auto-bought</div></div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <button type="button" onClick={() => toggle(s, { alertInApp: !s.alertInApp })} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5', s.alertInApp ? 'bg-info-dim text-info' : 'bg-surface-3 text-subtle line-through')}><Bell className="size-3" />In-app</button>
            <button type="button" onClick={() => toggle(s, { alertEmail: !s.alertEmail })} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5', s.alertEmail ? 'bg-accent-dim text-accent' : 'bg-surface-3 text-subtle line-through')}><Mail className="size-3" />Email</button>
            {s.autoBuy && <span className="inline-flex items-center gap-1 rounded-full bg-ok-dim px-2 py-0.5 text-ok"><Zap className="size-3" />Auto-buy ≤ {fmtInt(s.autoBuyMaxPerWeek)}/week{s.autoBuyMaxPrice != null ? ` · ≤ ${money(s.autoBuyMaxPrice * 100, currency)}` : ''}</span>}
            <span className="ml-auto text-subtle">{s.lastCheckedAt ? `Checked ${fmtAgo(s.lastCheckedAt)}` : 'Not checked yet'}</span>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button size="sm" variant="primary" onClick={() => { onApply(s); void api(`/api/v1/marketplace/searches/${s.id}/seen`, { method: 'POST' }).then(() => invalidate(qc)); }}><Search /> View leads</Button>
            <Button size="sm" loading={busy === `${s.id}-r`} onClick={() => act(`${s.id}-r`, async () => { const r = await api<{ newMatches: number; bought: number; note: string | null }>(`/api/v1/marketplace/searches/${s.id}/run`, { method: 'POST' }); toast.success(r.bought ? `Auto-bought ${r.bought} lead${r.bought === 1 ? '' : 's'}` : `${fmtInt(r.newMatches)} new match${r.newMatches === 1 ? '' : 'es'}`, { description: r.note ?? undefined }); })}><Play /> Check now</Button>
            <Button size="sm" variant="ghost" onClick={() => setEdit(s)}><Pencil /> Edit</Button>
            <Button size="sm" variant="ghost" className="ml-auto" loading={busy === `${s.id}-d`} onClick={() => act(`${s.id}-d`, () => api(`/api/v1/marketplace/searches/${s.id}`, { method: 'DELETE' }), 'Saved search deleted')} aria-label="Delete"><Trash2 /></Button>
          </div>
        </Card>
      ))}
      {data.rows.length >= data.limits.max && <InlineNotice className="lg:col-span-2">You’ve reached the limit of {data.limits.max} saved searches.</InlineNotice>}
      {edit && <SaveSearchDialog conditions={edit.filter.conditions} existing={edit} canBuy={canBuy} currency={currency} onClose={() => setEdit(null)} />}
    </div>
  );
}

// ── Watchlist ──────────────────────────────────────────────────────

export function useWatchlist() {
  const qc = useQueryClient();
  const { data } = useApiQuery<{ ids: string[] }>('/api/v1/marketplace/watchlist?ids=1');
  const ids = new Set(data?.ids ?? []);
  const toggle = async (leadId: string) => {
    const on = !ids.has(leadId);
    try {
      await api('/api/v1/marketplace/watchlist', { body: { leadId, on } });
      toast.success(on ? 'Added to watchlist' : 'Removed from watchlist');
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/marketplace/watchlist') });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return { ids, toggle };
}

export function StarButton({ on, onClick, size = 'sm' }: { on: boolean; onClick: () => void; size?: 'sm' | 'md' }) {
  return (
    <button type="button" aria-label={on ? 'Remove from watchlist' : 'Add to watchlist'} aria-pressed={on} onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn('grid place-items-center rounded-md transition-colors', size === 'md' ? 'size-9 border border-border' : 'size-7', on ? 'text-warn' : 'text-subtle hover:text-fg')}>
      <Star className={size === 'md' ? 'size-4' : 'size-3.5'} fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}

export function Watchlist({ currency, canRequest, onOpen, onRequest }: { currency: string; canRequest: boolean; onOpen: (r: MarketRow) => void; onRequest: (ids: string[]) => void }) {
  const { data, isLoading } = useApiQuery<{ total: number; rows: MarketRow[]; gone: number }>('/api/v1/marketplace/watchlist');
  const w = useWatchlist();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [compare, setCompare] = useState(false);
  if (isLoading || !data) return <Skeleton className="h-48" />;
  if (!data.rows.length) {
    return (
      <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span className="grid size-12 place-items-center rounded-xl bg-warn-dim text-warn"><Star className="size-5" /></span>
        <div className="text-[14px] font-medium">Your watchlist is empty</div>
        <p className="max-w-md text-[12.5px] text-muted">Tap the star on any lead to shortlist it. Compare up to 4 side by side, then request the best ones.</p>
      </Card>
    );
  }
  const flip = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else if (n.size < 4) n.add(id); else toast.message('Compare up to 4 leads'); return n; });
  const rows = data.rows.filter((r) => picked.has(r.id));
  return (
    <div className="flex flex-col gap-3 pb-16">
      {data.gone > 0 && <InlineNotice>{data.gone} watched lead{data.gone === 1 ? ' was' : 's were'} bought by someone else and removed.</InlineNotice>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-muted">{fmtInt(data.rows.length)} watched · select up to 4 to compare</span>
        <Button size="sm" className="ml-auto" disabled={picked.size < 2} onClick={() => setCompare(true)}><Columns3 /> Compare {picked.size > 1 ? picked.size : ''}</Button>
        {canRequest && <Button size="sm" variant="primary" disabled={!picked.size} onClick={() => onRequest([...picked])}><ShoppingCart /> Request {picked.size || ''}</Button>}
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {data.rows.map((r) => (
          <Card key={r.id} className={cn('flex cursor-pointer flex-col gap-2 p-3.5 transition-colors hover:border-border-strong', picked.has(r.id) && 'border-fg ring-1 ring-fg')} onClick={() => onOpen(r)}>
            <div className="flex items-start gap-2.5">
              <button type="button" onClick={(e) => { e.stopPropagation(); flip(r.id); }} aria-label="Select to compare" className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded border', picked.has(r.id) ? 'border-fg bg-fg text-inverse' : 'border-border-strong')}>{picked.has(r.id) && <Check className="size-3" strokeWidth={3} />}</button>
              <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium">{r.company?.name ?? r.ref}</div><div className="truncate text-[11.5px] text-subtle">{[r.industry, [r.state, r.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || r.ref}</div></div>
              <StarButton on={w.ids.has(r.id)} onClick={() => w.toggle(r.id)} />
            </div>
            <div className="flex items-center gap-2 text-[11.5px]">
              <span className="tnum text-[15px] font-semibold">{money(r.priceCents, currency)}</span>
              {r.fresh && <span className="rounded-full bg-ok-dim px-2 py-0.5 text-[10.5px] text-ok">Fresh</span>}
              <span className="ml-auto text-subtle">Score {r.score}{r.research ? ` · Research ${r.research.score}` : ''}</span>
            </div>
          </Card>
        ))}
      </div>
      {compare && <CompareDialog rows={rows} currency={currency} canRequest={canRequest} onClose={() => setCompare(false)} onRequest={() => { setCompare(false); onRequest(rows.map((r) => r.id)); }} />}
    </div>
  );
}

function CompareDialog({ rows, currency, canRequest, onClose, onRequest }: { rows: MarketRow[]; currency: string; canRequest: boolean; onClose: () => void; onRequest: () => void }) {
  const best = <T,>(get: (r: MarketRow) => T | null | undefined, better: (a: T, b: T) => boolean) => {
    let top: string | null = null; let v: T | null = null;
    for (const r of rows) { const x = get(r); if (x == null) continue; if (v == null || better(x, v)) { v = x; top = r.id; } }
    return top;
  };
  const cheapest = best((r) => r.priceCents, (a, b) => a < b);
  const topScore = best((r) => r.score, (a, b) => a > b);
  const topResearch = best((r) => r.research?.score, (a, b) => a > b);
  const line: [string, (r: MarketRow) => React.ReactNode, string | null][] = [
    ['Price', (r) => <span className="tnum font-semibold">{money(r.priceCents, currency)}</span>, cheapest],
    ['Lead score', (r) => <span className="tnum">{r.score}</span>, topScore],
    ['Research', (r) => (r.research ? `${r.research.score} · ${researchLabel(r.research.score)}` : '—'), topResearch],
    ['Industry', (r) => r.industry ?? r.company?.industry ?? '—', null],
    ['Location', (r) => [r.state, r.country].filter(Boolean).join(', ') || '—', null],
    ['Seniority', (r) => r.seniority ?? '—', null],
    ['Company size', (r) => r.company?.size ?? '—', null],
    ['Founded', (r) => r.company?.founded ?? '—', null],
    ['Email / phone', (r) => [r.hasEmail ? 'Email' : null, r.hasPhone ? 'Phone' : null].filter(Boolean).join(' + ') || '—', null],
    ['Fresh', (r) => (r.fresh ? 'Never sold' : 'Sold before'), null],
    ['Added', (r) => fmtAgo(r.createdAt), null],
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="xl" title="Compare leads" description="Best value in each row is highlighted."
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button>{canRequest && <Button variant="primary" onClick={onRequest}><ShoppingCart /> Request these {rows.length}</Button>}</>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-[12.5px]">
          <thead><tr><th className="w-32" />{rows.map((r) => <th key={r.id} className="px-3 pb-2 text-left align-bottom"><div className="truncate text-[13px] font-medium">{r.company?.name ?? r.ref}</div><div className="font-mono text-[10.5px] font-normal text-subtle">{r.ref}</div></th>)}</tr></thead>
          <tbody>
            {line.map(([k, get, top]) => (
              <tr key={k} className="border-t border-border">
                <td className="py-2 pr-3 text-[11.5px] text-subtle">{k}</td>
                {rows.map((r) => <td key={r.id} className={cn('px-3 py-2', top === r.id && 'bg-ok-dim font-medium text-ok')}>{get(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-subtle"><X className="size-3" />Contact details stay hidden until delivery.</p>
    </Dialog>
  );
}
