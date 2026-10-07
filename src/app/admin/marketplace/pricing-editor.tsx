'use client';
import { ArrowDown, ArrowUp, Calculator, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { FilterBuilder } from '@/components/data/filter-builder';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/overlay';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import type { FilterField } from '@/lib/filters';
import { useApiQuery } from '@/lib/hooks';
import { PriceBreakdown } from '@/components/marketplace/company-preview';
import { buildQuote, describeRule, INFO_ATTRIBUTES, money, priceLead, type InfoKey, type Pricing, type PricingRule } from '@/lib/pricing';
import { DynamicPricingCard, ImpactCard, useImpact } from './dynamic-pricing';

type Facets = { countries: string[]; industries: string[]; sources: string[]; campaigns: string[]; orgs: { id: string; name: string }[] };

export function PricingEditor() {
  const { data, refetch } = useApiQuery<{ pricing: Pricing }>('/api/v1/marketplace/pricing');
  const facets = useApiQuery<Facets>('/api/v1/leads/facets');
  const [p, setP] = useState<Pricing | null>(null);
  const [saving, setSaving] = useState(false);
  const impact = useImpact(p);
  useEffect(() => { if (data) setP(data.pricing); }, [data]);
  const dirty = p && data && JSON.stringify(p) !== JSON.stringify(data.pricing);
  const fields: FilterField[] = useMemo(() => {
    const o = (xs: string[] = []) => xs.map((v) => ({ value: v, label: v }));
    return [
      { key: 'industry', label: 'Industry', type: 'enum', options: o(facets.data?.industries) },
      { key: 'country', label: 'Country', type: 'enum', options: o(facets.data?.countries) },
      { key: 'state', label: 'State / region', type: 'text' },
      { key: 'source', label: 'Source', type: 'enum', options: o(facets.data?.sources) },
      { key: 'campaign', label: 'Campaign', type: 'enum', options: o(facets.data?.campaigns) },
      { key: 'priority', label: 'Priority', type: 'enum', options: o(['LOW', 'MEDIUM', 'HIGH', 'URGENT']) },
      { key: 'score', label: 'Score', type: 'number' },
      { key: 'ageDays', label: 'Age (days since added)', type: 'number' },
      { key: 'distributionCount', label: 'Times previously distributed', type: 'number' },
    ];
  }, [facets.data]);
  if (!p) return <Skeleton className="h-96" />;
  const set = (patch: Partial<Pricing>) => setP({ ...p, ...patch });
  const setRule = (i: number, patch: Partial<PricingRule>) => set({ rules: p.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const move = (i: number, d: -1 | 1) => { const r = [...p.rules]; const [x] = r.splice(i, 1); r.splice(i + d, 0, x); set({ rules: r }); };
  const save = async () => {
    setSaving(true);
    try {
      await api('/api/v1/marketplace/pricing', { method: 'PUT', body: p });
      toast.success('Pricing saved — new quotes use it immediately');
      await refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const cur = p.currency;

  return (
    <div className="grid grid-cols-1 gap-4 pb-16 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardHeader title="Marketplace" description="What clients can see and how requests are handled." />
          <CardBody className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Toggle title="Marketplace open" hint="Clients can browse and request available leads." checked={p.marketplaceEnabled} onChange={(v) => set({ marketplaceEnabled: v })} />
            <Toggle title="Show the price list to clients" hint="Base price, adjustments and discounts on their Billing page." checked={p.showPriceList} onChange={(v) => set({ showPriceList: v })} />
            <Toggle title="Deliver free demo leads instantly" hint="Requests fully covered by the free allowance skip review." checked={p.autoApproveFree} onChange={(v) => set({ autoApproveFree: v })} />
            <Toggle title="Deliver paid requests instantly" hint="Otherwise paid requests wait for your approval." checked={p.autoApprovePaid} onChange={(v) => set({ autoApprovePaid: v })} />
            <Toggle title="Announce new leads automatically" hint="Notify client dashboards when imports or manual additions add leads." checked={p.autoAnnounce} onChange={(v) => set({ autoAnnounce: v })} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Company preview" description="Everything known about the company helps clients decide before buying. People’s names, emails and phone numbers are never shown until the lead is purchased; clients can also Ask AI about the company." />
          <CardBody className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Toggle title="Show company preview" hint="Adds a Company column and a details panel to the marketplace." checked={p.companyPreview.enabled} onChange={(v) => set({ companyPreview: { ...p.companyPreview, enabled: v } })} />
            <Toggle title="Company name" hint="Shown in the marketplace and Ask AI. People and contacts stay hidden." checked={p.companyPreview.name} onChange={(v) => set({ companyPreview: { ...p.companyPreview, name: v } })} />
            <Toggle title="Company website & LinkedIn page" hint="The company's own web presence (needs Company name). Never its phone or email." checked={p.companyPreview.website} onChange={(v) => set({ companyPreview: { ...p.companyPreview, website: v } })} />
            <Toggle title="What the company does" hint="Short description with the company's name removed." checked={p.companyPreview.description} onChange={(v) => set({ companyPreview: { ...p.companyPreview, description: v } })} />
            <Toggle title="Company size" hint="Employee range, e.g. 11–50." checked={p.companyPreview.size} onChange={(v) => set({ companyPreview: { ...p.companyPreview, size: v } })} />
            <Toggle title="Founded / years in business" hint="When stated on the company's website." checked={p.companyPreview.founded} onChange={(v) => set({ companyPreview: { ...p.companyPreview, founded: v } })} />
            <Toggle title="Business keywords" hint="What it sells, e.g. “commercial roofing”." checked={p.companyPreview.keywords} onChange={(v) => set({ companyPreview: { ...p.companyPreview, keywords: v } })} />
            <Toggle title="Trust signals" hint="Business email domain, live website, company LinkedIn page, phone type — yes/no only." checked={p.companyPreview.signals} onChange={(v) => set({ companyPreview: { ...p.companyPreview, signals: v } })} />
            <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-[12.5px] md:col-span-2">
              <span><span className="block font-medium">Headquarters detail</span><span className="block text-[11.5px] text-subtle">More precise locations make a company easier to identify.</span></span>
              <select className="h-7 rounded-md border border-border-strong bg-surface-2 px-2 text-[12px]" value={p.companyPreview.headquarters} onChange={(e) => set({ companyPreview: { ...p.companyPreview, headquarters: e.target.value as Pricing['companyPreview']['headquarters'] } })}>
                <option value="none">Hidden</option><option value="country">Country</option><option value="region">State / region</option><option value="city">City</option>
              </select>
            </label>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Prices" />
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Field label="Currency"><Select value={cur} onChange={(e) => set({ currency: e.target.value })}>{['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'AED', 'SGD'].map((c) => <option key={c}>{c}</option>)}</Select></Field>
            <Field label="Standard price per lead"><Input type="number" min={0} step={0.5} value={p.basePrice} onChange={(e) => set({ basePrice: Math.max(0, Number(e.target.value)) })} /></Field>
            <Field label="Minimum price per lead"><Input type="number" min={0} step={0.5} value={p.minPrice} onChange={(e) => set({ minPrice: Math.max(0, Number(e.target.value)) })} /></Field>
            <Field label="Free demo leads per client"><Input type="number" min={0} value={p.freeLeadsPerClient} onChange={(e) => set({ freeLeadsPerClient: Math.max(0, Math.round(Number(e.target.value))) })} /></Field>
            <Field label="Tax %"><Input type="number" min={0} max={100} step={0.5} value={p.taxPct} onChange={(e) => set({ taxPct: Math.min(100, Math.max(0, Number(e.target.value))) })} /></Field>
            <Field label="Max leads per request"><Input type="number" min={1} max={5000} value={p.maxPerRequest} onChange={(e) => set({ maxPerRequest: Math.min(5000, Math.max(1, Math.round(Number(e.target.value)))) })} /></Field>
          </CardBody>
        </Card>

        <DynamicPricingCard p={p} set={set} impact={impact.impact} />

        <Card>
          <CardHeader title="Custom pricing rules" description="Applied top to bottom to every lead's standard price. A rule applies when all its conditions match." actions={<Button size="sm" onClick={() => set({ rules: [...p.rules, { id: `r${Date.now().toString(36)}`, name: 'New rule', enabled: true, conditions: [], action: 'MULTIPLY', amount: 120 }] })}><Plus /> Add rule</Button>} />
          <CardBody className="flex flex-col gap-3">
            {!p.rules.length && <div className="py-6 text-center text-[12.5px] text-subtle">No rules — every lead costs the standard price.</div>}
            {p.rules.map((r, i) => (
              <div key={r.id} className={cn('rounded-lg border p-3', r.enabled ? 'border-border-strong' : 'border-dashed border-border opacity-70')}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="grid size-6 place-items-center rounded-md bg-surface-3 text-[11px] font-semibold tabular-nums">{i + 1}</span>
                  <Input value={r.name} maxLength={80} onChange={(e) => setRule(i, { name: e.target.value })} className="h-8 max-w-[260px] font-medium" aria-label="Rule name" />
                  <Select value={r.action} onChange={(e) => setRule(i, { action: e.target.value as PricingRule['action'], amount: e.target.value === 'MULTIPLY' ? 120 : p.basePrice })} className="h-8 w-44" aria-label="Effect">
                    <option value="MULTIPLY">Multiply price by %</option><option value="SET">Set price to</option><option value="ADD">Add / subtract amount</option>
                  </Select>
                  <div className="relative"><Input type="number" step={r.action === 'MULTIPLY' ? 5 : 0.5} value={r.amount} onChange={(e) => setRule(i, { amount: Number(e.target.value) })} className="h-8 w-28 pr-9" aria-label="Amount" /><span className="absolute top-1/2 right-2.5 -translate-y-1/2 text-[11px] text-subtle">{r.action === 'MULTIPLY' ? '%' : cur}</span></div>
                  <span className="ml-auto flex items-center gap-0.5">
                    <Switch checked={r.enabled} onCheckedChange={(v) => setRule(i, { enabled: v })} aria-label="Rule enabled" />
                    <Button size="icon" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp /></Button>
                    <Button size="icon" variant="ghost" disabled={i === p.rules.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown /></Button>
                    <Button size="icon" variant="ghost" onClick={() => set({ rules: p.rules.filter((_, j) => j !== i) })} aria-label="Delete rule"><Trash2 /></Button>
                  </span>
                </div>
                <div className="mt-2.5 rounded-md bg-surface-2 p-2.5"><FilterBuilder fields={fields} value={r.conditions} onChange={(c) => setRule(i, { conditions: c })} /></div>
                <div className="mt-2 text-[11.5px] text-subtle">{describeRule(r, cur)}</div>
              </div>
            ))}
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Volume discounts" description="On the paid part of a request." actions={<Button size="xs" variant="ghost" onClick={() => set({ volumeTiers: [...p.volumeTiers, { minQty: (p.volumeTiers.at(-1)?.minQty ?? 25) * 2, discountPct: 10 }] })}><Plus /> Tier</Button>} />
            <CardBody className="flex flex-col gap-2">
              {p.volumeTiers.map((t, i) => (
                <div key={i} className="flex items-center gap-2 text-[12.5px]">
                  <Input type="number" min={2} value={t.minQty} className="h-8 w-24" aria-label="Minimum leads" onChange={(e) => set({ volumeTiers: p.volumeTiers.map((x, j) => (j === i ? { ...x, minQty: Math.max(2, Math.round(Number(e.target.value))) } : x)) })} />
                  <span className="text-subtle">+ leads →</span>
                  <Input type="number" min={0} max={90} value={t.discountPct} className="h-8 w-20" aria-label="Discount percent" onChange={(e) => set({ volumeTiers: p.volumeTiers.map((x, j) => (j === i ? { ...x, discountPct: Math.min(90, Math.max(0, Number(e.target.value))) } : x)) })} />
                  <span className="text-subtle">% off</span>
                  <Button size="icon" variant="ghost" className="ml-auto" onClick={() => set({ volumeTiers: p.volumeTiers.filter((_, j) => j !== i) })} aria-label="Remove tier"><Trash2 /></Button>
                </div>
              ))}
              {!p.volumeTiers.length && <div className="text-[12px] text-subtle">No volume discounts.</div>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Client-specific terms" description="Extra discount or a different free allowance." actions={<Button size="xs" variant="ghost" onClick={() => set({ overrides: [...p.overrides, { organizationId: '', discountPct: 0 }] })}><Plus /> Client</Button>} />
            <CardBody className="flex flex-col gap-2">
              {p.overrides.map((o, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <Select value={o.organizationId} className="h-8 min-w-0 flex-1" aria-label="Client" onChange={(e) => set({ overrides: p.overrides.map((x, j) => (j === i ? { ...x, organizationId: e.target.value } : x)) })}>
                    <option value="">Choose a client…</option>{(facets.data?.orgs ?? []).map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
                  </Select>
                  <Input type="number" min={0} max={100} placeholder="% off" value={o.discountPct ?? ''} className="h-8 w-20" aria-label="Discount" onChange={(e) => set({ overrides: p.overrides.map((x, j) => (j === i ? { ...x, discountPct: e.target.value === '' ? undefined : Number(e.target.value) } : x)) })} />
                  <Input type="number" min={0} placeholder="free" value={o.freeLeads ?? ''} className="h-8 w-20" aria-label="Free leads" onChange={(e) => set({ overrides: p.overrides.map((x, j) => (j === i ? { ...x, freeLeads: e.target.value === '' ? undefined : Math.round(Number(e.target.value)) } : x)) })} />
                  <Button size="icon" variant="ghost" onClick={() => set({ overrides: p.overrides.filter((_, j) => j !== i) })} aria-label="Remove"><Trash2 /></Button>
                </div>
              ))}
              {!p.overrides.length && <div className="text-[12px] text-subtle">All clients use the standard terms.</div>}
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="flex flex-col gap-4 xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)] xl:self-start xl:overflow-y-auto"><ImpactCard {...impact} dirty={Boolean(dirty)} /><PriceTester p={p} facets={facets.data} /></div>

      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur lg:left-[232px]">
          <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-2.5 md:px-6">
            <span className="text-[12.5px] text-muted">Unsaved pricing changes</span>
            {p.overrides.some((o) => !o.organizationId) && <InlineNotice tone="warn" className="py-1">Choose a client for every client-specific row.</InlineNotice>}
            <Button variant="ghost" className="ml-auto" onClick={() => setP(data!.pricing)}>Discard</Button>
            <Button variant="primary" loading={saving} disabled={p.overrides.some((o) => !o.organizationId)} onClick={save}>Save pricing</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ title, hint, checked, onChange }: { title: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-[12.5px]">
      <span><span className="block font-medium">{title}</span><span className="block text-[11.5px] text-subtle">{hint}</span></span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} />
    </label>
  );
}

/** Live price calculator using the unsaved settings — exactly what clients will be quoted. */
function PriceTester({ p, facets }: { p: Pricing; facets?: Facets }) {
  const [lead, setLead] = useState({ country: '', state: '', industry: '', source: '', campaign: '', score: 50, priority: 'MEDIUM', ageDays: 3, distributionCount: 0 });
  const [qty, setQty] = useState(25);
  const [info, setInfo] = useState<Partial<Record<InfoKey, boolean>>>({ email: true, businessEmail: true, phone: true, company: true, industry: true, jobTitle: true });
  const [research, setResearch] = useState<number | null>(null);
  const priced = priceLead({ ...lead, country: lead.country || null, state: lead.state || null, industry: lead.industry || null, source: lead.source || null, campaign: lead.campaign || null, createdAt: new Date(Date.now() - lead.ageDays * 86400_000), info: { ...info, researchConfidence: research } }, p);
  const quote = buildQuote(Array.from({ length: qty }, (_, i) => ({ leadId: String(i), ...priced })), p, { freeRemaining: p.freeLeadsPerClient });
  const sel = (k: 'country' | 'industry' | 'source' | 'campaign', xs: string[] = []) => (
    <Select value={lead[k]} onChange={(e) => setLead({ ...lead, [k]: e.target.value })} className="h-8 text-[12px]" aria-label={k}><option value="">Any {k}</option>{xs.map((x) => <option key={x}>{x}</option>)}</Select>
  );
  return (
    <Card>
      <CardHeader title="Price tester" description="Try any lead profile against your settings" actions={<Calculator className="size-4 text-subtle" />} />
      <CardBody className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          {sel('industry', facets?.industries)}{sel('country', facets?.countries)}{sel('source', facets?.sources)}{sel('campaign', facets?.campaigns)}
          <label className="text-[11px] text-subtle">Score<Input type="number" value={lead.score} onChange={(e) => setLead({ ...lead, score: Number(e.target.value) })} className="mt-0.5 h-8" /></label>
          <label className="text-[11px] text-subtle">Age (days)<Input type="number" value={lead.ageDays} onChange={(e) => setLead({ ...lead, ageDays: Number(e.target.value) })} className="mt-0.5 h-8" /></label>
          <label className="text-[11px] text-subtle">Priority<Select value={lead.priority} onChange={(e) => setLead({ ...lead, priority: e.target.value })} className="mt-0.5 h-8">{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((x) => <option key={x}>{x}</option>)}</Select></label>
          <label className="text-[11px] text-subtle">Times sold<Input type="number" min={0} value={lead.distributionCount} onChange={(e) => setLead({ ...lead, distributionCount: Number(e.target.value) })} className="mt-0.5 h-8" /></label>
        </div>
        {p.dynamic.enabled && (
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[11px] text-subtle"><span>Lead has</span><button type="button" className="hover:text-fg" onClick={() => setInfo(Object.fromEntries(INFO_ATTRIBUTES.map((a) => [a.key, !INFO_ATTRIBUTES.every((x) => info[x.key])])))}>Toggle all</button></div>
            <div className="flex flex-wrap gap-1">
              {INFO_ATTRIBUTES.map((a) => (
                <button key={a.key} type="button" onClick={() => setInfo({ ...info, [a.key]: !info[a.key] })} className={cn('rounded-md border px-1.5 py-0.5 text-[11px]', info[a.key] ? 'border-fg bg-fg text-inverse' : 'border-border text-muted hover:border-border-strong')}>{a.label.replace(/ \(.*\)$/, '')}</button>
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-[11px] text-subtle">Research confidence
              <Select value={research == null ? '' : String(research)} onChange={(e) => setResearch(e.target.value === '' ? null : Number(e.target.value))} className="h-7 flex-1 text-[12px]"><option value="">Not researched</option>{[40, 60, 80, 95].map((c) => <option key={c} value={c}>{c}%</option>)}</Select>
            </label>
          </div>
        )}
        <div className="rounded-lg bg-fg px-4 py-3 text-inverse">
          <div className="text-[10.5px] tracking-[0.12em] uppercase opacity-70">Price per lead</div>
          <div className="tnum text-[26px] font-semibold tracking-[-0.03em]">{money(priced.cents, p.currency)}</div>
          <div className="text-[11.5px] opacity-70">{priced.applied.length ? priced.applied.join(' → ') : 'Standard price'}</div>
        </div>
        {priced.steps.length > 1 && <PriceBreakdown steps={priced.steps} total={priced.cents} currency={p.currency} title="Breakdown" />}
        <div className="border-t border-border pt-3">
          <div className="mb-2 flex items-center justify-between text-[12px]"><span className="text-muted">A first request of</span><Input type="number" min={1} max={5000} value={qty} onChange={(e) => setQty(Math.min(5000, Math.max(1, Number(e.target.value))))} className="h-7 w-20 text-right" aria-label="Quantity" /></div>
          <div className="flex flex-col gap-1 text-[12px] text-muted">
            <div className="flex justify-between"><span>Free demo leads</span><span className="tnum">{quote.freeApplied}</span></div>
            <div className="flex justify-between"><span>Paid leads</span><span className="tnum">{quote.paidCount} × {money(priced.cents, p.currency)}</span></div>
            {quote.discountCents > 0 && <div className="flex justify-between"><span>Volume discount <Badge tone="outline">{quote.tierPct}%</Badge></span><span className="tnum">−{money(quote.discountCents, p.currency)}</span></div>}
            {quote.taxCents > 0 && <div className="flex justify-between"><span>Tax</span><span className="tnum">{money(quote.taxCents, p.currency)}</span></div>}
            <div className="mt-1 flex justify-between border-t border-border pt-1.5 text-[13px] font-medium text-fg"><span>Client pays</span><span className="tnum">{money(quote.totalCents, p.currency)}</span></div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
