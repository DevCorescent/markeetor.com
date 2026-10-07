'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRight, BellPlus, Bookmark, Building2, EyeOff, Gift, Layers, Lock, Mail, Phone, Search, Sparkles, Star, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { DataTable, emptySelection, selectionCount, type SelectionState } from '@/components/data/data-table';
import { findCond, MultiFilter, RangeFilter, setCond } from '@/components/data/quick-filters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Switch, Tabs, TabsList, TabsTrigger, Tooltip } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { ErrorState } from '@/components/ui/states';
import { errorMessage } from '@/lib/api-client';
import type { Condition } from '@/lib/filters';
import { fmtAgo, fmtInt, humanize } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';
import { money } from '@/lib/pricing';
import { ResearchScore } from '@/components/company/research-score';
import { CompanyCell, LeadPreviewDrawer, type MarketRow } from './company-preview';
import { CouponOffers } from './coupon-offers';
import { openLeadFinder } from './lead-finder';
import { RequestDialog, type MarketSelection } from './request-dialog';
import { RequestsTable } from './requests';
import { SavedSearches, SaveSearchDialog, StarButton, useWatchlist, Watchlist, type SavedSearch } from './saved-searches';

type Row = MarketRow;
type Facet = { value: string; count: number };
type Facets = { countries: Facet[]; industries: Facet[]; sources: Facet[]; campaigns: Facet[]; states: Facet[]; total: number; fresh: number; addedThisWeek: number };
type Billing = { currency: string; allowance: { total: number; used: number; remaining: number }; outstanding: number; pendingRequests: number };

const AGE = [['', 'Any time'], ['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']] as const;

export function Marketplace({ canRequest }: { canRequest: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [s, set] = useUrlState({ tab: 'browse' });
  const facets = useApiQuery<Facets>('/api/v1/marketplace/facets');
  const billing = useApiQuery<Billing>('/api/v1/marketplace/billing');
  const [conditions, setConditions] = useState<Condition[]>(() => {
    try { const f = sp.get('filter'); return f ? (JSON.parse(f) as { conditions: Condition[] }).conditions ?? [] : []; } catch { return []; }
  });
  const coupon = sp.get('coupon') ?? undefined;
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ id: string; desc: boolean } | null>(sp.get('sort') === 'new' ? { id: 'createdAt', desc: true } : null);
  const [sel, setSel] = useState<SelectionState>(emptySelection());
  const [requesting, setRequesting] = useState<MarketSelection | null>(null);
  const [preview, setPreview] = useState<Row | null>(null);
  const [saving, setSaving] = useState(false);
  const watch = useWatchlist();
  const watched = watch.ids;
  // Deep link from a saved-search alert: /app/marketplace?tab=saved&search=<id> opens its leads.
  const deepSearch = sp.get('search');
  const searches = useApiQuery<{ rows: SavedSearch[] }>(deepSearch ? '/api/v1/marketplace/searches' : null);
  useEffect(() => {
    const hit = searches.data?.rows.find((x) => x.id === deepSearch);
    if (!hit) return;
    setConditions(hit.filter.conditions);
    set({ tab: 'browse' });
  }, [searches.data, deepSearch]); // eslint-disable-line react-hooks/exhaustive-deps
  const kwCond = findCond(conditions, 'keyword')?.value;
  const [kw, setKw] = useState(Array.isArray(kwCond) ? String(kwCond[0] ?? '') : '');
  useEffect(() => {
    const t = setTimeout(() => setConditions((cs) => setCond(cs, 'keyword', kw.trim().length >= 2 ? { field: 'keyword', op: 'in', value: [kw.trim().toLowerCase()] } : null)), 400);
    return () => clearTimeout(t);
  }, [kw]);
  const profiledOnly = Boolean(findCond(conditions, 'enrichment'));
  const filterKey = JSON.stringify({ conditions });
  useEffect(() => { setPage(1); setSel((x) => (x.all ? emptySelection() : x)); }, [filterKey]);
  const list = useApiQuery<{ total: number; rows: Row[]; currency: string }>(`/api/v1/marketplace/leads?page=${page}&pageSize=25&filter=${encodeURIComponent(filterKey)}${sort ? `&sort=${encodeURIComponent(JSON.stringify(sort))}` : ''}`);
  const total = list.data?.total ?? 0;
  const count = selectionCount(sel, total);
  const currency = list.data?.currency ?? billing.data?.currency ?? 'USD';
  const selectedOnPage = (list.data?.rows ?? []).filter((r) => (sel.all ? !sel.excluded.has(r.id) : sel.ids.has(r.id)));
  const estimate = sel.all ? null : selectedOnPage.reduce((a, r) => a + r.priceCents, 0);
  const opt = (xs: Facet[] = []) => xs.map((f) => ({ value: f.value, label: `${f.value} (${fmtInt(f.count)})` }));
  const age = findCond(conditions, 'createdAt')?.value;
  const freshOnly = findCond(conditions, 'distributionCount', 'eq')?.value === 0;
  const a = billing.data?.allowance;

  const selection: MarketSelection | null = sel.all ? { mode: 'filter', filter: { conditions }, excludeIds: [...sel.excluded] } : sel.ids.size ? { mode: 'ids', ids: [...sel.ids] } : null;

  const columns: ColumnDef<Row, unknown>[] = useMemo(() => [
    { id: 'watch', header: '', cell: ({ row: { original: r } }) => <StarButton on={watched.has(r.id)} onClick={() => watch.toggle(r.id)} /> },
    {
      id: 'ref', header: 'Lead',
      cell: ({ row: { original: r } }) => (
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-surface-2 text-subtle"><Lock className="size-3.5" /></span>
          <div><div className="font-mono text-[12px] text-fg">{r.ref}</div><div className="flex gap-1">{r.fresh && <Badge tone="solid" className="h-4 px-1 text-[9.5px]">Fresh</Badge>}{r.seniority && <span className="text-[11px] text-subtle">{r.seniority}</span>}</div></div>
        </div>
      ),
    },
    { id: 'company', header: 'Company', cell: ({ row: { original: r } }) => <CompanyCell c={r.company} industry={r.industry} /> },
    { id: 'industry', header: 'Industry', enableSorting: true, cell: ({ row: { original: r } }) => <span>{r.industry ?? <span className="text-subtle">—</span>}</span> },
    { id: 'country', header: 'Location', enableSorting: true, cell: ({ row: { original: r } }) => <span className="text-muted">{[r.state, r.country].filter(Boolean).join(', ') || '—'}</span> },
    { id: 'source', header: 'Source', cell: ({ row: { original: r } }) => <div><div className="text-muted">{r.source ?? '—'}</div>{r.campaign && <div className="max-w-[150px] truncate text-[11px] text-subtle">{r.campaign}</div>}</div> },
    {
      id: 'score', header: 'Score', enableSorting: true,
      cell: ({ row: { original: r } }) => <div className="flex w-20 items-center gap-2"><div className="h-1.5 flex-1 rounded-full bg-surface-3"><div className="h-full rounded-full bg-fg" style={{ width: `${Math.min(100, r.score)}%` }} /></div><span className="tnum w-6 text-right text-[11.5px]">{r.score}</span></div>,
    },
    { id: 'research', header: 'Research', enableSorting: true, cell: ({ row: { original: r } }) => <ResearchScore r={r.research} /> },
    { id: 'contact', header: 'Contact', cell: ({ row: { original: r } }) => <span className="flex gap-1.5 text-subtle">{r.hasEmail && <Tooltip content="Has an email address"><Mail className="size-3.5" /></Tooltip>}{r.hasPhone && <Tooltip content="Has a phone number"><Phone className="size-3.5" /></Tooltip>}</span> },
    { id: 'createdAt', header: 'Added', enableSorting: true, cell: ({ row: { original: r } }) => <span className="text-subtle">{fmtAgo(r.createdAt)}</span> },
    {
      id: 'price', header: 'Price',
      cell: ({ row: { original: r } }) => (
        <span className="tnum font-medium">{money(r.priceCents, currency)}</span>
      ),
    },
    ...(canRequest ? [{
      id: 'act', header: '',
      cell: ({ row: { original: r } }: { row: { original: Row } }) => <span onClick={(e) => e.stopPropagation()}><Button size="xs" variant="outline" onClick={() => setRequesting({ mode: 'ids', ids: [r.id] })}>Request</Button></span>,
    }] : []),
  ], [canRequest, currency, watched]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader
        title="Lead marketplace"
        description="Every lead the platform can offer you right now. Names and contact details stay hidden until a lead is delivered to your workspace — then it appears in My leads."
        actions={<div className="flex items-center gap-3"><Button size="sm" variant="primary" onClick={() => openLeadFinder()}><Sparkles /> Ask Lead Finder</Button><Link href="/app/leads" className="text-[12.5px] text-muted hover:text-fg">Go to My leads <ArrowRight className="inline size-3.5" /></Link></div>}
      />

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="relative overflow-hidden rounded-lg border border-fg bg-fg px-4 py-3.5 text-inverse">
          <div className="flex items-center gap-1.5 text-[10.5px] font-medium tracking-[0.12em] uppercase opacity-70"><Gift className="size-3.5" />Free demo leads</div>
          <div className="mt-2 flex items-baseline gap-1.5"><span className="tnum text-[26px] leading-none font-semibold tracking-[-0.03em]">{a ? fmtInt(a.remaining) : '—'}</span><span className="text-[12px] opacity-70">of {a ? fmtInt(a.total) : '—'} left</span></div>
          <div className="mt-2.5 h-1 rounded-full bg-inverse/20"><div className="h-full rounded-full bg-inverse" style={{ width: `${a && a.total ? (a.remaining / a.total) * 100 : 0}%` }} /></div>
        </div>
        <Card className="px-4 py-3.5"><div className="eyebrow">Available now</div><div className="tnum mt-2 text-[24px] leading-none font-[520] tracking-[-0.03em]">{fmtInt(facets.data?.total ?? 0)}</div><div className="mt-1.5 text-[11.5px] text-subtle">{fmtInt(facets.data?.fresh ?? 0)} never offered to anyone</div></Card>
        <Card className="px-4 py-3.5"><div className="eyebrow">Added this week</div><div className="tnum mt-2 text-[24px] leading-none font-[520] tracking-[-0.03em]">{fmtInt(facets.data?.addedThisWeek ?? 0)}</div><div className="mt-1.5 text-[11.5px] text-subtle">New leads arrive regularly — you are notified</div></Card>
        <Card className="px-4 py-3.5"><div className="eyebrow">Your requests</div><div className="tnum mt-2 text-[24px] leading-none font-[520] tracking-[-0.03em]">{fmtInt(billing.data?.pendingRequests ?? 0)} <span className="text-[13px] font-normal text-subtle">pending</span></div><div className="mt-1.5 text-[11.5px] text-subtle">{billing.data && billing.data.outstanding > 0 ? `${money(billing.data.outstanding * 100, billing.data.currency)} outstanding · ` : ''}<Link href="/app/billing" className="underline underline-offset-2 hover:text-fg">Billing</Link></div></Card>
      </div>

      {s.tab === 'browse' && <div className="mb-5"><CouponOffers compact currency={currency} /></div>}
      {coupon && <div className="mb-4 rounded-lg border border-dashed border-fg/60 px-4 py-2.5 text-[12.5px]">Coupon <b className="font-mono">{coupon}</b> will be applied to your next request.</div>}
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}>
        <TabsList className="mb-4 overflow-x-auto">
          <TabsTrigger value="browse">Browse leads</TabsTrigger>
          <TabsTrigger value="saved"><span className="inline-flex items-center gap-1.5"><Bookmark className="size-3.5 text-info" />Saved searches</span></TabsTrigger>
          <TabsTrigger value="watchlist"><span className="inline-flex items-center gap-1.5"><Star className="size-3.5 text-warn" />Watchlist{watched.size ? ` · ${watched.size}` : ''}</span></TabsTrigger>
          <TabsTrigger value="requests">My requests</TabsTrigger>
        </TabsList>
      </Tabs>

      {s.tab === 'saved' ? <SavedSearches canBuy={canRequest} currency={currency} onApply={(x) => { setConditions(x.filter.conditions); set({ tab: 'browse' }); }} />
        : s.tab === 'watchlist' ? <Watchlist currency={currency} canRequest={canRequest} onOpen={setPreview} onRequest={(ids) => setRequesting({ mode: 'ids', ids })} />
        : s.tab === 'requests' ? <RequestsTable /> : list.error ? <ErrorState description={errorMessage(list.error)} /> : (
        <div className="pb-16">
          <DataTable
            columns={columns} data={list.data?.rows ?? []} total={total} page={page} pageSize={25} onPage={setPage} loading={list.isFetching}
            sort={sort} onSort={setSort} getRowId={(r) => r.id} onRowClick={(r) => setPreview(r)} selection={canRequest ? sel : undefined} onSelection={canRequest ? setSel : undefined}
            empty={<div className="py-12 text-center text-[12.5px] text-subtle">No leads match these filters right now.</div>}
            toolbar={
              <div className="flex w-full flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative w-full max-w-[260px]"><Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" /><Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="What the company does, e.g. roofing" aria-label="Search by business" className="h-7 pl-8 text-[12px]" /></div>
                  <label className="flex items-center gap-2 text-[12px] text-muted"><Switch checked={profiledOnly} onCheckedChange={(v) => setConditions(setCond(conditions, 'enrichment', v ? { field: 'enrichment', op: 'in', value: ['DONE'] } : null))} aria-label="With company profile" /><Building2 className="size-3.5" />With company profile</label>
                  <MultiFilter label="Country" field="country" options={opt(facets.data?.countries)} conditions={conditions} onChange={setConditions} negatable />
                  <MultiFilter label="State / region" field="state" options={opt(facets.data?.states)} conditions={conditions} onChange={setConditions} />
                  <MultiFilter label="Industry" field="industry" options={opt(facets.data?.industries)} conditions={conditions} onChange={setConditions} negatable />
                  <MultiFilter label="Source" field="source" options={opt(facets.data?.sources)} conditions={conditions} onChange={setConditions} negatable />
                  <MultiFilter label="Campaign" field="campaign" options={opt(facets.data?.campaigns)} conditions={conditions} onChange={setConditions} />
                  <MultiFilter label="Priority" field="priority" options={['URGENT', 'HIGH', 'MEDIUM', 'LOW'].map((p) => ({ value: p, label: humanize(p) }))} conditions={conditions} onChange={setConditions} />
                  <RangeFilter label="Score" field="score" conditions={conditions} onChange={setConditions} />
                  <Select className="h-7 w-36 text-[12px]" aria-label="Added" value={typeof age === 'number' ? String(age) : ''} onChange={(e) => setConditions(setCond(conditions, 'createdAt', e.target.value ? { field: 'createdAt', op: 'last_days', value: Number(e.target.value) } : null))}>
                    {AGE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                  <label className="flex items-center gap-2 text-[12px] text-muted"><Switch checked={freshOnly} onCheckedChange={(v) => setConditions(setCond(conditions, 'distributionCount', v ? { field: 'distributionCount', op: 'eq', value: 0 } : null, 'eq'))} aria-label="Fresh only" /><Sparkles className="size-3.5" />Fresh only</label>
                  {conditions.length > 0 && <button type="button" onClick={() => setConditions([])} className="flex items-center gap-1 text-[12px] text-subtle hover:text-fg"><X className="size-3" />Clear</button>}
                  <span className="ml-auto flex items-center gap-2 text-[12px] text-subtle">
                    {conditions.length > 0 && <Button size="xs" variant="outline" onClick={() => setSaving(true)}><BellPlus /> Save search</Button>}
                    <span><b className="tnum font-medium text-fg">{fmtInt(total)}</b> available</span>
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[11.5px] text-subtle"><EyeOff className="size-3.5" />Contact people, websites, emails and phone numbers are hidden — click a lead to see its company profile and Ask AI about the business. Full details unlock once delivered.</div>
              </div>
            }
          />
          {canRequest && count === 0 && total > 0 && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-dashed border-border-strong px-4 py-3 text-[12.5px] text-muted">
              <span>Tick the leads you want, or request a batch of everything that matches your filters.</span>
              <Button size="sm" variant="primary" onClick={() => setSel({ all: true, ids: new Set(), excluded: new Set() })}><Layers /> Select all {fmtInt(total)}</Button>
            </div>
          )}
        </div>
      )}

      {canRequest && count > 0 && s.tab === 'browse' && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur lg:left-[232px]">
          <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-2.5 md:px-6">
            <span className="text-[12.5px]"><b className="tnum font-semibold">{fmtInt(count)}</b> lead{count === 1 ? '' : 's'} selected{sel.all && <span className="text-subtle"> (all matching)</span>}</span>
            {estimate != null && <span className="text-[12.5px] text-muted">≈ {money(estimate, currency)} before free leads & discounts</span>}
            <Button variant="ghost" className="ml-auto" onClick={() => setSel(emptySelection())}>Clear</Button>
            <Button variant="primary" onClick={() => setRequesting(selection)}>Request {fmtInt(count)} lead{count === 1 ? '' : 's'} <ArrowRight /></Button>
          </div>
        </div>
      )}

      {saving && <SaveSearchDialog conditions={conditions} canBuy={canRequest} currency={currency} onClose={() => setSaving(false)} onSaved={() => set({ tab: 'saved' })} />}
      {preview && <LeadPreviewDrawer watched={watched.has(preview.id)} onWatch={() => watch.toggle(preview.id)} row={preview} currency={currency} canRequest={canRequest} onClose={() => setPreview(null)} onRequest={() => { const id = preview.id; setPreview(null); setRequesting({ mode: 'ids', ids: [id] }); }}
        onResearched={(company) => { setPreview((p) => (p ? { ...p, company } : p)); list.refetch(); }} />}
      <RequestDialog
        selection={requesting}
        initialCoupon={coupon}
        onClose={() => setRequesting(null)}
        onDone={(r) => {
          setRequesting(null);
          setSel(emptySelection());
          list.refetch(); facets.refetch(); billing.refetch();
          if (r.status === 'FULFILLED' || r.status === 'PARTIAL') router.push('/app/leads?view=unassigned');
          else set({ tab: 'requests' });
        }}
      />
    </>
  );
}
