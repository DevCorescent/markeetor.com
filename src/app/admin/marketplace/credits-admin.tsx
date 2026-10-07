'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Clock, Coins, History, Inbox, Minus, Plus, Search, Settings2, Trash2, TrendingUp, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CreditHistoryTable, CreditRequestsTable } from '@/components/credits/credits-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, Drawer, Switch } from '@/components/ui/overlay';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { creditCost, fmtCredits, priceCreditPurchase, type CreditSettings } from '@/lib/credits';
import { fmtAgo } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { money } from '@/lib/pricing';

type Overview = {
  totals: { outstanding: number; issued: number; spent: number; expired: number; revenue: { currency: string; total: number; count: number }[]; pendingRequests: number; awaitingPayment: number };
  wallets: { organizationId: string; name: string; balance: number; lifetimeIn: number; lifetimeSpent: number; expiringSoon: number; lastActivity: string }[];
};
type Org = { id: string; name: string };

const SECTIONS = [
  { key: 'requests', label: 'Purchase requests', icon: Inbox },
  { key: 'wallets', label: 'Client wallets', icon: Wallet },
  { key: 'history', label: 'Ledger history', icon: History },
  { key: 'rules', label: 'Credit rules', icon: Settings2 },
] as const;

/** Super-admin credits centre: purchase queue, client balances, full ledger and the rules clients buy and spend under. */
export function CreditsAdmin({ currency }: { currency: string }) {
  const [section, setSection] = useState<(typeof SECTIONS)[number]['key']>('requests');
  const { data } = useApiQuery<Overview>('/api/v1/credits/overview', { refetchInterval: 30_000 });
  const facets = useApiQuery<{ orgs: Org[] }>('/api/v1/leads/facets');
  const orgs = facets.data?.orgs ?? [];
  const [adjust, setAdjust] = useState<{ organizationId: string } | null>(null);
  const [wallet, setWallet] = useState<Overview['wallets'][number] | null>(null);
  const t = data?.totals;
  const open = (t?.pendingRequests ?? 0) + (t?.awaitingPayment ?? 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={Inbox} label="Needs action" value={fmtCredits(open)} sub={`${fmtCredits(t?.pendingRequests ?? 0)} new · ${fmtCredits(t?.awaitingPayment ?? 0)} awaiting payment`} strong={open > 0} onClick={() => setSection('requests')} />
        <Tile icon={Coins} label="Credits held by clients" value={fmtCredits(t?.outstanding ?? 0)} sub={`${fmtCredits(data?.wallets.filter((w) => w.balance > 0).length ?? 0)} workspaces with a balance`} onClick={() => setSection('wallets')} />
        <Tile icon={TrendingUp} label="Credit sales" value={t?.revenue.length ? t.revenue.map((r) => money(r.total * 100, r.currency)).join(' + ') : money(0, currency)} sub={`${fmtCredits(t?.revenue.reduce((a, r) => a + r.count, 0) ?? 0)} completed purchases`} />
        <Tile icon={History} label="Issued / spent" value={`${fmtCredits(t?.issued ?? 0)} / ${fmtCredits(t?.spent ?? 0)}`} sub={`${fmtCredits(t?.expired ?? 0)} expired`} onClick={() => setSection('history')} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {SECTIONS.map((s) => (
          <button key={s.key} type="button" onClick={() => setSection(s.key)} className={cn('inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[12.5px]', section === s.key ? 'border-fg bg-fg text-inverse' : 'border-border text-muted hover:border-border-strong hover:text-fg')}>
            <s.icon className="size-3.5" />{s.label}{s.key === 'requests' && open > 0 && <span className={cn('tnum rounded px-1 text-[10.5px]', section === s.key ? 'bg-inverse/20' : 'bg-surface-3')}>{open}</span>}
          </button>
        ))}
        <Button size="sm" variant="primary" className="ml-auto" onClick={() => setAdjust({ organizationId: '' })}><Plus /> Add / remove credits</Button>
      </div>

      {section === 'requests' && <Card><div className="p-3"><CreditRequestsTable admin defaultStatus="OPEN" /></div></Card>}
      {section === 'wallets' && <Wallets data={data} onAdjust={(id) => setAdjust({ organizationId: id })} onOpen={setWallet} />}
      {section === 'history' && <Card><div className="p-3"><CreditHistoryTable admin orgs={orgs} /></div></Card>}
      {section === 'rules' && <CreditRules currency={currency} orgs={orgs} />}

      {adjust && <AdjustDialog orgs={orgs} initialOrg={adjust.organizationId} onClose={() => setAdjust(null)} />}
      {wallet && (
        <Drawer open onOpenChange={(o) => !o && setWallet(null)} width="lg" title={wallet.name} description={`Balance ${fmtCredits(wallet.balance)} · received ${fmtCredits(wallet.lifetimeIn)} · spent ${fmtCredits(wallet.lifetimeSpent)}`}
          footer={<Button variant="primary" onClick={() => setAdjust({ organizationId: wallet.organizationId })}><Plus /> Add / remove credits</Button>}>
          <div className="flex flex-col gap-4">
            <div><div className="eyebrow mb-2">Purchase requests</div><CreditRequestsTable admin organizationId={wallet.organizationId} /></div>
            <div><div className="eyebrow mb-2">Ledger</div><CreditHistoryTable admin organizationId={wallet.organizationId} /></div>
          </div>
        </Drawer>
      )}
    </div>
  );
}

function Tile({ icon: Icon, label, value, sub, strong, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub: string; strong?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick} className={cn('rounded-lg border bg-surface px-4 py-3.5 text-left transition-colors enabled:hover:border-border-strong', strong ? 'border-fg ring-1 ring-fg' : 'border-border')}>
      <div className="eyebrow flex items-center gap-1.5"><Icon className="size-3.5" />{label}</div>
      <div className="tnum mt-2 truncate text-[22px] leading-none font-[520] tracking-[-0.03em]">{value}</div>
      <div className="mt-1.5 text-[11.5px] text-subtle">{sub}</div>
    </button>
  );
}

function Wallets({ data, onAdjust, onOpen }: { data?: Overview; onAdjust: (orgId: string) => void; onOpen: (w: Overview['wallets'][number]) => void }) {
  const [q, setQ] = useState('');
  const rows = (data?.wallets ?? []).filter((w) => !q || w.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Search className="size-3.5 text-subtle" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client…" className="h-7 flex-1 bg-transparent text-[12.5px] outline-none" aria-label="Find a client" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">{['Client', 'Balance', 'Received', 'Spent', 'Expiring (30d)', 'Last activity', ''].map((h) => <th key={h} className="h-9 px-4 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.organizationId} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-surface-2" onClick={() => onOpen(w)}>
                <td className="px-4 py-2.5 font-medium">{w.name}</td>
                <td className="tnum px-4 font-semibold">{fmtCredits(w.balance)}</td>
                <td className="tnum px-4 text-muted">{fmtCredits(w.lifetimeIn)}</td>
                <td className="tnum px-4 text-muted">{fmtCredits(w.lifetimeSpent)}</td>
                <td className={cn('tnum px-4', w.expiringSoon > 0 ? 'text-warn' : 'text-subtle')}>{w.expiringSoon > 0 ? <span className="inline-flex items-center gap-1"><Clock className="size-3" />{fmtCredits(w.expiringSoon)}</span> : '—'}</td>
                <td className="px-4 text-subtle">{fmtAgo(w.lastActivity)}</td>
                <td className="px-4 text-right"><Button size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); onAdjust(w.organizationId); }}>Adjust</Button></td>
              </tr>
            ))}
            {!data ? <tr><td colSpan={7} className="p-4"><Skeleton className="h-20" /></td></tr> : !rows.length && <tr><td colSpan={7} className="py-10 text-center text-subtle">No client wallets yet — they open with a client’s first credit purchase or grant.</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function AdjustDialog({ orgs, initialOrg, onClose }: { orgs: Org[]; initialOrg: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [org, setOrg] = useState(initialOrg);
  const [dir, setDir] = useState<'add' | 'remove'>('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [expiry, setExpiry] = useState<'default' | 'never' | 'days'>('default');
  const [days, setDays] = useState('90');
  const [busy, setBusy] = useState(false);
  const n = Math.floor(Number(amount) || 0);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ balance: number }>('/api/v1/credits/adjust', { body: { organizationId: org, credits: dir === 'add' ? n : -n, reason, ...(dir === 'add' && expiry !== 'default' ? { expiryDays: expiry === 'never' ? null : Number(days) } : {}) } });
      toast.success(`${dir === 'add' ? 'Added' : 'Removed'} ${fmtCredits(n)} credits`, { description: `New balance ${fmtCredits(r.balance)}` });
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/credits') });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add or remove credits" description="For goodwill, offline payments or corrections. The client is notified and the change is recorded in the ledger and audit log."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={dir === 'add' ? 'primary' : 'danger'} loading={busy} disabled={!org || n <= 0 || reason.trim().length < 3} onClick={save}>{dir === 'add' ? 'Add' : 'Remove'} {n > 0 ? fmtCredits(n) : ''} credits</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Client"><Select value={org} onChange={(e) => setOrg(e.target.value)}><option value="">Choose a client…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-2">
          {(['add', 'remove'] as const).map((d) => (
            <button key={d} type="button" onClick={() => setDir(d)} className={cn('flex items-center justify-center gap-1.5 rounded-md border py-2 text-[12.5px]', dir === d ? 'border-fg bg-surface-2 font-medium' : 'border-border text-muted')}>{d === 'add' ? <Plus className="size-3.5" /> : <Minus className="size-3.5" />}{d === 'add' ? 'Add credits' : 'Remove credits'}</button>
          ))}
        </div>
        <Field label="Credits"><Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
        {dir === 'add' && (
          <Field label="Expiry">
            <div className="flex gap-2">
              <Select value={expiry} onChange={(e) => setExpiry(e.target.value as typeof expiry)}><option value="default">Default rule</option><option value="never">Never expire</option><option value="days">After…</option></Select>
              {expiry === 'days' && <Input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} className="w-28" aria-label="Days" />}
            </div>
          </Field>
        )}
        <Field label="Reason" hint="Shown to the client and kept in the audit log"><Textarea rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={dir === 'add' ? 'e.g. Offline payment received, goodwill for delayed delivery' : 'e.g. Duplicate grant corrected'} /></Field>
      </div>
    </Dialog>
  );
}

// ── Rules editor ───────────────────────────────────────────────────

function CreditRules({ currency, orgs }: { currency: string; orgs: Org[] }) {
  const { data, refetch } = useApiQuery<{ settings: CreditSettings }>('/api/v1/credits/settings');
  const [s, setS] = useState<CreditSettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) setS(data.settings); }, [data]);
  if (!s) return <Skeleton className="h-96" />;
  const dirty = JSON.stringify(s) !== JSON.stringify(data?.settings);
  const set = (patch: Partial<CreditSettings>) => setS({ ...s, ...patch });
  const save = async () => {
    setSaving(true);
    try {
      await api('/api/v1/credits/settings', { method: 'PUT', body: s });
      toast.success('Credit rules saved');
      await refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const example = (cents: number, n = 1) => creditCost({ totalCents: cents * n, taxCents: 0, paidCount: n }, s);
  const sample = priceCreditPurchase({ credits: Math.max(s.custom.minCredits, 1000) }, s);
  const L = s.label.toLowerCase();
  return (
    <div className="flex flex-col gap-4 pb-16">
      <Card>
        <CardHeader title="Credits" description="Let clients prepay for leads. Requests paid with credits are charged when placed, settled on delivery and refunded for anything not delivered." actions={<Switch checked={s.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label="Credits enabled" />} />
        <CardBody className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="What clients call them"><Input value={s.label} maxLength={30} onChange={(e) => set({ label: e.target.value })} /></Field>
          <Toggle title="Deliver credit-paid requests instantly" hint="Otherwise they wait for your approval (credits stay held)." checked={s.autoDeliver} onChange={(v) => set({ autoDeliver: v })} />
          <Toggle title="Clients can still pay by invoice" hint="Off: paid leads can only be bought with credits." checked={s.allowInvoice} onChange={(v) => set({ allowInvoice: v })} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Spending credits on leads" description="How many credits a lead costs. Free demo leads never use credits; volume, account and coupon discounts apply first." />
        <CardBody className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Field label="Lead cost"><Select value={s.costMode} onChange={(e) => set({ costMode: e.target.value as CreditSettings['costMode'] })}><option value="price">From the lead’s price (dynamic)</option><option value="fixed">Fixed credits per lead</option></Select></Field>
            {s.costMode === 'price'
              ? <Field label={`Value of 1 credit (${currency})`}><Input type="number" min={0.01} step={0.01} value={s.creditValue} onChange={(e) => set({ creditValue: Math.max(0.01, Number(e.target.value)) })} /></Field>
              : <Field label="Credits per paid lead"><Input type="number" min={1} value={s.fixedCreditsPerLead} onChange={(e) => set({ fixedCreditsPerLead: Math.max(1, Math.round(Number(e.target.value))) })} /></Field>}
            <Field label="Discount when paying with credits (%)"><Input type="number" min={0} max={90} value={s.spendDiscountPct} onChange={(e) => set({ spendDiscountPct: Math.min(90, Math.max(0, Number(e.target.value))) })} /></Field>
          </div>
          <div className="flex flex-wrap gap-1.5 text-[12px] text-muted">
            <span>Examples:</span>
            {[500, 1000, 2500].map((c) => <Badge key={c} tone="outline">{money(c, currency)} lead → {fmtCredits(example(c))} {L}</Badge>)}
            <Badge tone="outline">25 × {money(1000, currency)} leads → {fmtCredits(example(1000, 25))} {L}</Badge>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Credit packs" description="Ready-made bundles clients can request." actions={<Button size="sm" onClick={() => set({ packages: [...s.packages, { id: `pack-${Date.now().toString(36)}`, name: 'New pack', description: '', credits: 1000, bonusCredits: 0, price: 1000, popular: false, enabled: true }] })}><Plus /> Add pack</Button>} />
        <CardBody className="flex flex-col gap-2">
          {s.packages.map((p, i) => {
            const up = (patch: Partial<typeof p>) => set({ packages: s.packages.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            const perCredit = p.credits + p.bonusCredits > 0 ? p.price / (p.credits + p.bonusCredits) : 0;
            return (
              <div key={p.id} className={cn('grid grid-cols-1 items-end gap-2 rounded-lg border border-border p-3 md:grid-cols-[1.2fr_1.6fr_0.8fr_0.8fr_0.8fr_auto]', !p.enabled && 'opacity-55')}>
                <Field label="Name"><Input value={p.name} maxLength={60} onChange={(e) => up({ name: e.target.value })} /></Field>
                <Field label="Description"><Input value={p.description} maxLength={200} onChange={(e) => up({ description: e.target.value })} /></Field>
                <Field label="Credits"><Input type="number" min={1} value={p.credits} onChange={(e) => up({ credits: Math.max(1, Math.round(Number(e.target.value))) })} /></Field>
                <Field label="Bonus"><Input type="number" min={0} value={p.bonusCredits} onChange={(e) => up({ bonusCredits: Math.max(0, Math.round(Number(e.target.value))) })} /></Field>
                <Field label={`Price (${currency})`}><Input type="number" min={0} step={0.01} value={p.price} onChange={(e) => up({ price: Math.max(0, Number(e.target.value)) })} /></Field>
                <div className="flex items-center gap-2 pb-1">
                  <label className="flex items-center gap-1.5 text-[11.5px] text-muted"><Switch checked={p.enabled} onCheckedChange={(v) => up({ enabled: v })} aria-label="Pack enabled" />On</label>
                  <label className="flex items-center gap-1.5 text-[11.5px] text-muted"><Switch checked={p.popular} onCheckedChange={(v) => set({ packages: s.packages.map((x, j) => ({ ...x, popular: j === i ? v : v ? false : x.popular })) })} aria-label="Popular" />Popular</label>
                  <Button size="xs" variant="ghost" aria-label="Remove pack" onClick={() => set({ packages: s.packages.filter((_, j) => j !== i) })}><Trash2 /></Button>
                </div>
                <div className="text-[11px] text-subtle md:col-span-6">Effective {money(Math.round(perCredit * 100), currency)} per credit{p.bonusCredits > 0 ? ` incl. ${Math.round((p.bonusCredits / p.credits) * 100)}% bonus` : ''}{s.costMode === 'price' ? ` · worth ${money(Math.round((p.credits + p.bonusCredits) * s.creditValue * 100), currency)} of leads` : ` · ${fmtCredits(Math.floor((p.credits + p.bonusCredits) / s.fixedCreditsPerLead))} leads`}</div>
              </div>
            );
          })}
          {!s.packages.length && <p className="text-[12px] text-subtle">No packs — clients can only buy custom amounts.</p>}
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Custom amounts" description="Clients enter any number of credits." actions={<Switch checked={s.custom.enabled} onCheckedChange={(v) => set({ custom: { ...s.custom, enabled: v } })} aria-label="Custom amounts" />} />
          <CardBody className={cn('flex flex-col gap-3', !s.custom.enabled && 'pointer-events-none opacity-50')}>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Minimum"><Input type="number" min={1} value={s.custom.minCredits} onChange={(e) => set({ custom: { ...s.custom, minCredits: Math.max(1, Math.round(Number(e.target.value))) } })} /></Field>
              <Field label="Maximum"><Input type="number" min={1} value={s.custom.maxCredits} onChange={(e) => set({ custom: { ...s.custom, maxCredits: Math.max(1, Math.round(Number(e.target.value))) } })} /></Field>
              <Field label={`Price / credit (${currency})`}><Input type="number" min={0.0001} step={0.01} value={s.custom.pricePerCredit} onChange={(e) => set({ custom: { ...s.custom, pricePerCredit: Math.max(0.0001, Number(e.target.value)) } })} /></Field>
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between"><span className="eyebrow">Bonus tiers</span><Button size="xs" variant="ghost" onClick={() => set({ bonusTiers: [...s.bonusTiers, { minCredits: (s.bonusTiers.at(-1)?.minCredits ?? 1000) * 2, bonusPct: 10 }] })}><Plus /> Tier</Button></div>
              {s.bonusTiers.map((t, i) => (
                <div key={i} className="mb-1.5 flex items-center gap-2 text-[12.5px]">
                  <span className="text-muted">Buy</span><Input type="number" min={1} value={t.minCredits} className="h-8 w-28" aria-label="Minimum credits" onChange={(e) => set({ bonusTiers: s.bonusTiers.map((x, j) => (j === i ? { ...x, minCredits: Math.max(1, Math.round(Number(e.target.value))) } : x)) })} />
                  <span className="text-muted">+ credits, get</span><Input type="number" min={0} max={200} value={t.bonusPct} className="h-8 w-20" aria-label="Bonus %" onChange={(e) => set({ bonusTiers: s.bonusTiers.map((x, j) => (j === i ? { ...x, bonusPct: Math.min(200, Math.max(0, Number(e.target.value))) } : x)) })} />
                  <span className="text-muted">% bonus</span>
                  <Button size="xs" variant="ghost" className="ml-auto" aria-label="Remove tier" onClick={() => set({ bonusTiers: s.bonusTiers.filter((_, j) => j !== i) })}><Trash2 /></Button>
                </div>
              ))}
              {'credits' in sample && <p className="text-[11.5px] text-subtle">Example: {fmtCredits(sample.credits)} credits cost {money(sample.totalCents, currency)}{sample.bonusCredits ? ` and come with ${fmtCredits(sample.bonusCredits)} bonus` : ''}.</p>}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Terms" />
          <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Tax on credit purchases (%)"><Input type="number" min={0} max={100} step={0.5} value={s.taxPct} onChange={(e) => set({ taxPct: Math.min(100, Math.max(0, Number(e.target.value))) })} /></Field>
            <Field label="Credits expire after" hint="Days after they are added; soonest-expiring are spent first">
              <div className="flex gap-2">
                <Select value={s.expiryDays == null ? 'never' : 'days'} onChange={(e) => set({ expiryDays: e.target.value === 'never' ? null : 365 })}><option value="never">Never</option><option value="days">Days…</option></Select>
                {s.expiryDays != null && <Input type="number" min={1} max={3650} value={s.expiryDays} className="w-24" aria-label="Expiry days" onChange={(e) => set({ expiryDays: Math.min(3650, Math.max(1, Math.round(Number(e.target.value)))) })} />}
              </div>
            </Field>
            <Field label="Welcome credits for new workspaces"><Input type="number" min={0} value={s.welcomeCredits} onChange={(e) => set({ welcomeCredits: Math.max(0, Math.round(Number(e.target.value))) })} /></Field>
            <Field label="Low-balance alert below" hint="0 = off"><Input type="number" min={0} value={s.lowBalanceThreshold} onChange={(e) => set({ lowBalanceThreshold: Math.max(0, Math.round(Number(e.target.value))) })} /></Field>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Payment" description="Shown to clients when they request credits; you can also send request-specific details from the queue." />
        <CardBody className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Field label="Payment instructions"><Textarea rows={5} value={s.paymentInstructions} maxLength={2000} onChange={(e) => set({ paymentInstructions: e.target.value })} placeholder={'Bank: …\nAccount: …\nIFSC: …\nUPI: …'} /></Field>
          <Field label="Payment methods you record" hint="Comma-separated"><Textarea rows={5} value={s.paymentMethods.join(', ')} onChange={(e) => set({ paymentMethods: e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12) })} /></Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Client-specific rules" description="A different spend discount or an extra bonus on every purchase." actions={<Button size="xs" variant="ghost" onClick={() => set({ overrides: [...s.overrides, { organizationId: '', spendDiscountPct: null, bonusPct: 0 }] })}><Plus /> Client</Button>} />
        <CardBody className="flex flex-col gap-2">
          {s.overrides.map((o, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <Select value={o.organizationId} className="h-8 w-56" aria-label="Client" onChange={(e) => set({ overrides: s.overrides.map((x, j) => (j === i ? { ...x, organizationId: e.target.value } : x)) })}><option value="">Choose a client…</option>{orgs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
              <span className="text-muted">spend discount</span><Input type="number" min={0} max={90} placeholder="default" value={o.spendDiscountPct ?? ''} className="h-8 w-24" aria-label="Spend discount" onChange={(e) => set({ overrides: s.overrides.map((x, j) => (j === i ? { ...x, spendDiscountPct: e.target.value === '' ? null : Math.min(90, Math.max(0, Number(e.target.value))) } : x)) })} /><span className="text-muted">%, purchase bonus</span>
              <Input type="number" min={0} max={200} value={o.bonusPct} className="h-8 w-20" aria-label="Bonus" onChange={(e) => set({ overrides: s.overrides.map((x, j) => (j === i ? { ...x, bonusPct: Math.min(200, Math.max(0, Number(e.target.value))) } : x)) })} /><span className="text-muted">%</span>
              <Button size="xs" variant="ghost" aria-label="Remove" onClick={() => set({ overrides: s.overrides.filter((_, j) => j !== i) })}><Trash2 /></Button>
            </div>
          ))}
          {!s.overrides.length && <p className="text-[12px] text-subtle">All clients use the standard credit rules.</p>}
        </CardBody>
      </Card>

      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur lg:left-[232px]">
          <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-2.5 md:px-6">
            <span className="text-[12.5px] text-muted">Unsaved credit rules</span>
            {s.overrides.some((o) => !o.organizationId) && <InlineNotice tone="warn" className="py-1">Choose a client for every client-specific row.</InlineNotice>}
            <Button variant="ghost" className="ml-auto" onClick={() => setS(data!.settings)}>Discard</Button>
            <Button variant="primary" loading={saving} disabled={s.overrides.some((o) => !o.organizationId)} onClick={save}>Save credit rules</Button>
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
