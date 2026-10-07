'use client';
import { ArrowRight, ArrowUp, Bot, Briefcase, Building2, CalendarClock, Check, Clock, ExternalLink, EyeOff, Gauge, Globe, LayoutGrid, Loader2, Lock, Mail, MapPin, Minus, Network, Phone, Search, ShieldCheck, Sparkles, Star, Tag, Users } from 'lucide-react';
import { useState } from 'react';
import { CompanyLinks, RegistrationBlock, type Registration } from '@/components/company/registry-view';
import { researchLabel, type ResearchInfo } from '@/components/company/research-score';
import type { CompanyLink } from '@/lib/company-registry';
import { api, errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Drawer, Tooltip } from '@/components/ui/overlay';
import { cn } from '@/lib/cn';
import { fmtAgo } from '@/lib/format';
import { money, type PriceStep } from '@/lib/pricing';

export type CompanyPreview = {
  name: string | null; researched: boolean; searched?: boolean; confidence: number; researchedAt: string | null;
  industry?: string | null; website?: string | null; linkedin?: string | null;
  specialty: string | null; description: string | null; size: string | null; founded: number | null; yearsInBusiness: number | null;
  headquarters: string | null; keywords: string[]; sellsTo: string | null;
  signals: { businessEmail: boolean | null; website: boolean | null; linkedin: boolean; phoneType: string | null } | null;
  registration?: Registration | null; links?: CompanyLink[];
};
export type MarketRow = {
  id: string; ref: string; country: string | null; state: string | null; industry: string | null; source: string | null; campaign: string | null; score: number; priority: string;
  createdAt: string; fresh: boolean; hasEmail: boolean; hasPhone: boolean; seniority: string | null; priceCents: number; research?: ResearchInfo; company: CompanyPreview | null;
};

const sizeLabel = (s: string) => `${s.replace('-', '–')} employees`;
const phoneLabel = (t: string | null) => (!t ? null : t === 'MOBILE' ? 'Mobile' : t === 'FIXED_LINE' ? 'Landline' : t === 'FIXED_LINE_OR_MOBILE' ? 'Mobile / landline' : t === 'unverified' ? 'Unverified' : 'Valid');

/** Compact company summary for the marketplace table. */
export function CompanyCell({ c, industry }: { c: CompanyPreview | null; industry: string | null }) {
  if (!c) return <span className="text-[11.5px] text-faint">No profile yet</span>;
  const line = [c.specialty ?? industry, c.size ? sizeLabel(c.size) : null].filter(Boolean).join(' · ');
  return (
    <div className="max-w-[260px]">
      {c.name && <div className="truncate text-[12.5px] font-medium text-fg">{c.name}</div>}
      <div className={cn('truncate', c.name ? 'text-[11.5px] text-muted' : 'text-[12.5px] text-fg')}>{line || (c.name ? '' : c.description?.slice(0, 60)) || (c.researched ? 'Company profile' : c.searched ? 'Basic checks only' : 'Not researched yet')}</div>
      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-subtle">
        {c.yearsInBusiness != null && c.yearsInBusiness > 0 && <span>{c.yearsInBusiness}+ yrs</span>}
        {c.headquarters && <span className="truncate">{c.headquarters}</span>}
        {c.signals?.businessEmail && <Tooltip content="Business email domain verified"><Mail className="size-3 text-ok" /></Tooltip>}
        {c.signals?.website && <Tooltip content="Company website is live"><Globe className="size-3 text-ok" /></Tooltip>}
        {c.signals?.linkedin && <Tooltip content="Company LinkedIn page found"><Network className="size-3 text-ok" /></Tooltip>}
      </div>
    </div>
  );
}

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'neutral';
const TONE: Record<Tone, { chip: string; text: string; bar: string; ring: string }> = {
  ok: { chip: 'bg-ok-dim text-ok', text: 'text-ok', bar: 'bg-ok', ring: 'border-ok/30' },
  warn: { chip: 'bg-warn-dim text-warn', text: 'text-warn', bar: 'bg-warn', ring: 'border-warn/30' },
  danger: { chip: 'bg-danger-dim text-danger', text: 'text-danger', bar: 'bg-danger', ring: 'border-danger/30' },
  info: { chip: 'bg-info-dim text-info', text: 'text-info', bar: 'bg-info', ring: 'border-info/30' },
  accent: { chip: 'bg-accent-dim text-accent', text: 'text-accent', bar: 'bg-accent', ring: 'border-accent/30' },
  neutral: { chip: 'bg-surface-3 text-muted', text: 'text-muted', bar: 'bg-fg/40', ring: 'border-border' },
};
const researchTone = (score: number): Tone => (score >= 80 ? 'ok' : score >= 60 ? 'info' : score >= 40 ? 'warn' : 'danger');
const leadScoreTone = (score: number): Tone => (score >= 70 ? 'ok' : score >= 40 ? 'info' : 'neutral');

function IconChip({ icon: I, tone, size = 'md' }: { icon: React.ComponentType<{ className?: string }>; tone: Tone; size?: 'sm' | 'md' }) {
  return <span className={cn('grid shrink-0 place-items-center rounded-md', size === 'md' ? 'size-8' : 'size-6', TONE[tone].chip)}><I className={size === 'md' ? 'size-4' : 'size-3.5'} /></span>;
}

function Kpi({ label, value, sub, tone, icon, meter }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone: Tone; icon: React.ComponentType<{ className?: string }>; meter?: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center justify-between gap-2"><span className="truncate text-[10.5px] font-medium tracking-[0.08em] text-subtle uppercase">{label}</span><IconChip icon={icon} tone={tone} size="sm" /></div>
      <div className="tnum truncate text-[19px] leading-none font-semibold tracking-[-0.03em]">{value}</div>
      {meter != null ? <div className="h-1 rounded-full bg-surface-3"><div className={cn('h-full rounded-full', TONE[tone].bar)} style={{ width: `${Math.max(3, Math.min(100, meter))}%` }} /></div> : sub ? <div className={cn('truncate text-[11px]', TONE[tone].text)}>{sub}</div> : null}
    </div>
  );
}

function SectionTitle({ icon, tone, title, hint, action }: { icon: React.ComponentType<{ className?: string }>; tone: Tone; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2.5">
      <IconChip icon={icon} tone={tone} size="sm" />
      <div className="min-w-0 flex-1"><div className="text-[13px] font-medium">{title}</div>{hint && <div className="truncate text-[11.5px] text-subtle">{hint}</div>}</div>
      {action}
    </div>
  );
}

const initials = (n: string) => n.replace(/\b(private|pvt|limited|ltd|llp|inc|the)\b\.?/gi, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '··';

type DrawerTab = 'overview' | 'company' | 'verify' | 'ask';

/** Pre-purchase view of one lead, in tabs: overview, company profile, verification checks and Ask AI. */
export function LeadPreviewDrawer({ row, currency, canRequest, onRequest, onClose, onResearched, watched, onWatch }: { row: MarketRow; currency: string; canRequest: boolean; onRequest: () => void; onClose: () => void; onResearched?: (c: CompanyPreview | null) => void; watched?: boolean; onWatch?: () => void }) {
  const [tab, setTab] = useState<DrawerTab>('overview');
  const c = row.company;
  // A freshly researched company (from the panel's Research button) has no row score yet: use its profile's.
  const research: ResearchInfo = row.research ?? (c?.searched ? { score: c.confidence, status: c.researched ? 'DONE' : 'PARTIAL', researchedAt: c.researchedAt } : null);
  const rTone = research ? researchTone(research.score) : 'neutral';
  const location = [row.state, row.country].filter(Boolean).join(', ');
  const s = c?.signals;
  const checks = s ? [
    { label: 'Business email domain', ok: s.businessEmail, detail: s.businessEmail == null ? 'No email on file' : s.businessEmail ? 'Company domain that receives mail' : 'Personal or unverified domain', icon: Mail },
    { label: 'Company website', ok: s.website, detail: s.website ? 'Live and reachable' : s.website === false ? 'Not reachable' : 'Not found', icon: Globe },
    { label: 'Company LinkedIn page', ok: s.linkedin, detail: s.linkedin ? 'Found' : 'Not found', icon: Network },
    { label: 'Phone number', ok: Boolean(s.phoneType && s.phoneType !== 'unverified'), detail: phoneLabel(s.phoneType) ?? 'Not checked', icon: Phone },
  ] : [];
  const passed = checks.filter((x) => x.ok).length;
  const facts: { icon: React.ComponentType<{ className?: string }>; tone: Tone; label: string; value: React.ReactNode }[] = [
    { icon: Building2, tone: 'info', label: 'Industry', value: [row.industry ?? c?.industry, c?.specialty].filter(Boolean).join(' · ') || '—' },
    ...(c?.size ? [{ icon: Users, tone: 'accent' as Tone, label: 'Company size', value: sizeLabel(c.size) }] : []),
    ...(c?.founded ? [{ icon: CalendarClock, tone: 'warn' as Tone, label: 'Founded', value: `${c.founded}${c.yearsInBusiness ? ` · ${c.yearsInBusiness} yrs` : ''}` }] : []),
    ...(c?.headquarters ? [{ icon: MapPin, tone: 'ok' as Tone, label: 'Headquarters', value: c.headquarters }] : []),
    ...(c?.sellsTo ? [{ icon: Sparkles, tone: 'accent' as Tone, label: 'Sells to', value: c.sellsTo }] : []),
    ...(c?.website ? [{ icon: Globe, tone: 'info' as Tone, label: 'Website', value: <a href={c.website} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex max-w-full items-center gap-1 truncate text-info hover:underline">{c.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}<ExternalLink className="size-3 shrink-0" /></a> }] : []),
    ...(c?.linkedin ? [{ icon: Network, tone: 'info' as Tone, label: 'LinkedIn', value: <a href={c.linkedin} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-info hover:underline">Company page<ExternalLink className="size-3" /></a> }] : []),
  ];
  const tabs: { key: DrawerTab; label: string; icon: React.ComponentType<{ className?: string }>; tone: Tone; badge?: React.ReactNode }[] = [
    { key: 'overview', label: 'Overview', icon: LayoutGrid, tone: 'accent' },
    { key: 'company', label: 'Company', icon: Building2, tone: 'info', badge: research ? <span className={cn('tnum', TONE[rTone].text)}>{research.score}</span> : <span className="size-1.5 rounded-full bg-warn" /> },
    ...(s ? [{ key: 'verify' as DrawerTab, label: 'Verification', icon: ShieldCheck, tone: 'ok' as Tone, badge: <span className="tnum text-subtle">{passed}/{checks.length}</span> }] : []),
    { key: 'ask', label: 'Ask AI', icon: Bot, tone: 'accent' },
  ];
  const name = c?.name ?? null;

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="lg"
      title={<span className="flex items-center gap-2"><span className="truncate">{name ?? row.ref}</span>{row.fresh && <span className="rounded-full bg-ok-dim px-2 py-0.5 text-[10.5px] font-medium text-ok">Fresh</span>}</span>}
      description={<span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="font-mono">{row.ref}</span>{row.industry && <><span className="text-faint">•</span><span>{row.industry}</span></>}{location && <><span className="text-faint">•</span><span className="inline-flex items-center gap-1"><MapPin className="size-3" />{location}</span></>}</span>}
      footer={canRequest ? (
        <>
          <div className="mr-auto flex flex-col leading-tight"><span className="text-[10.5px] tracking-[0.08em] text-subtle uppercase">Lead price</span><b className="tnum text-[17px] font-semibold tracking-[-0.02em]">{money(row.priceCents, currency)}</b></div>
          {onWatch && <button type="button" onClick={onWatch} aria-pressed={watched} className={cn('inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[12.5px]', watched ? 'border-warn/40 bg-warn-dim text-warn' : 'border-border text-muted hover:text-fg')}><Star className="size-3.5" fill={watched ? 'currentColor' : 'none'} />{watched ? 'Watching' : 'Watch'}</button>}
          <Button variant="primary" onClick={onRequest}>Request this lead <ArrowRight /></Button>
        </>
      ) : onWatch ? <button type="button" onClick={onWatch} className={cn('inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[12.5px]', watched ? 'border-warn/40 bg-warn-dim text-warn' : 'border-border text-muted')}><Star className="size-3.5" fill={watched ? 'currentColor' : 'none'} />{watched ? 'Watching' : 'Watch'}</button> : undefined}>
      <div className="flex flex-col gap-4">
        {/* Hero */}
        <div className="flex items-center gap-3.5 rounded-xl border border-border bg-gradient-to-br from-accent-dim via-surface to-info-dim px-4 py-3.5">
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-accent to-info text-[15px] font-semibold text-white shadow-sm">{name ? initials(name) : <Lock className="size-5" />}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold tracking-[-0.015em]">{name ?? 'Company hidden'}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {(row.industry ?? c?.industry) && <span className="rounded-full bg-info-dim px-2 py-0.5 text-[11px] font-medium text-info">{row.industry ?? c?.industry}</span>}
              {row.seniority && <span className="rounded-full bg-accent-dim px-2 py-0.5 text-[11px] font-medium text-accent">{row.seniority}</span>}
              {c?.size && <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-muted">{sizeLabel(c.size)}</span>}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Kpi label="Price" value={money(row.priceCents, currency)} sub={row.fresh ? 'Never sold before' : 'Previously offered'} tone={row.fresh ? 'ok' : 'neutral'} icon={Tag} />
          <Kpi label="Lead score" value={row.score} tone={leadScoreTone(row.score)} icon={Gauge} meter={row.score} />
          <Kpi label="Research" value={research ? research.score : '—'} tone={rTone} icon={Search} meter={research?.score} sub={research ? undefined : 'Not researched'} />
          <Kpi label="Added" value={fmtAgo(row.createdAt).replace(' ago', '')} sub="ago" tone="accent" icon={Clock} />
        </div>

        {/* Tabs */}
        <div className="sticky -top-4 z-10 -mx-5 border-b border-border bg-surface/95 px-5 pt-1 backdrop-blur">
          <div role="tablist" aria-label="Lead details" className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {tabs.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
                className={cn('flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-[12.5px] transition-colors', tab === t.key ? 'border-fg font-medium text-fg' : 'border-transparent text-muted hover:text-fg')}>
                <t.icon className={cn('size-3.5', tab === t.key ? TONE[t.tone].text : '')} />{t.label}{t.badge && <span className="ml-0.5 flex items-center text-[11px]">{t.badge}</span>}
              </button>
            ))}
          </div>
        </div>

        {tab === 'overview' && (
          <div className="flex flex-col gap-5">
            <section>
              <SectionTitle icon={Users} tone="accent" title="The lead" hint="Identity and contact details unlock after purchase" />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {([
                  [Briefcase, 'accent', 'Seniority', row.seniority ?? 'Not stated'],
                  [MapPin, 'info', 'Location', location || '—'],
                  [Mail, row.hasEmail ? 'ok' : 'neutral', 'Email', row.hasEmail ? (s?.businessEmail ? 'Business email' : 'Available') : 'Not available'],
                  [Phone, row.hasPhone ? 'ok' : 'neutral', 'Phone', row.hasPhone ? (phoneLabel(s?.phoneType ?? null) ?? 'Available') : 'Not available'],
                ] as [React.ComponentType<{ className?: string }>, Tone, string, string][]).map(([I, tone, k, v]) => (
                  <div key={k} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5"><IconChip icon={I} tone={tone} /><div className="min-w-0"><div className="text-[11px] text-subtle">{k}</div><div className="truncate text-[13px] font-medium">{v}</div></div></div>
                ))}
              </div>
            </section>

            <section>
              <SectionTitle icon={Building2} tone="info" title="Company snapshot" action={<button type="button" onClick={() => setTab('company')} className="inline-flex items-center gap-1 text-[12px] text-info hover:underline">Full profile <ArrowRight className="size-3" /></button>} />
              {!c?.researched && !c?.searched ? <ResearchCta leadId={row.id} onDone={onResearched} /> : (
                <div className="rounded-lg border border-border px-3.5 py-3">
                  {c?.description ? <p className="line-clamp-3 text-[13px] leading-relaxed text-fg-2">{c.description}</p> : <p className="text-[12.5px] text-muted">No public description yet — see the Company tab for registry links.</p>}
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {facts.slice(0, 4).filter((f) => typeof f.value === 'string' && f.value !== '—').map((f) => <span key={f.label} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]', TONE[f.tone].chip)}><f.icon className="size-3" />{f.value as string}</span>)}
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-accent/30 bg-accent-dim/60 px-4 py-3.5">
              <SectionTitle icon={Lock} tone="accent" title="Unlocks after purchase" hint="Delivered to My leads instantly or after review" />
              <ul className="grid grid-cols-2 gap-2 text-[12.5px]">
                {([['Contact person', true, Users], ['Job title', Boolean(row.seniority), Briefcase], ['Email address', row.hasEmail, Mail], ['Phone number', row.hasPhone, Phone]] as [string, boolean, React.ComponentType<{ className?: string }>][]).map(([k, ok, I]) => (
                  <li key={k} className={cn('flex items-center gap-2 rounded-md bg-surface px-2.5 py-2', !ok && 'opacity-50')}><I className="size-3.5 text-accent" /><span className={ok ? 'text-fg-2' : 'text-subtle line-through'}>{k}</span>{ok && <Check className="ml-auto size-3.5 text-ok" />}</li>
                ))}
              </ul>
            </section>
          </div>
        )}

        {tab === 'company' && (
          <div className="flex flex-col gap-4">
            {research ? (
              <div className={cn('flex items-start gap-3 rounded-xl border px-4 py-3', TONE[rTone].ring, TONE[rTone].chip.split(' ')[0])}>
                <div className="flex flex-col items-center"><span className={cn('tnum text-[22px] leading-none font-semibold', TONE[rTone].text)}>{research.score}</span><span className="mt-0.5 text-[9.5px] tracking-[0.1em] text-subtle uppercase">/ 100</span></div>
                <div className="min-w-0 text-[12.5px]">
                  <div className={cn('font-medium', TONE[rTone].text)}>Research · {researchLabel(research.score)}</div>
                  <p className="mt-0.5 text-fg-2">{research.status === 'PARTIAL' ? 'No public website was found, so only basic checks ran. Use the directory links below to confirm its registration.' : 'AI research built this profile from public sources.'}{research.researchedAt ? ` Checked ${fmtAgo(research.researchedAt)}.` : ''}</p>
                </div>
              </div>
            ) : <ResearchCta leadId={row.id} onDone={onResearched} />}
            {c?.description && <p className="text-[13.5px] leading-relaxed text-fg-2">{c.description}</p>}
            {(c?.researched || c?.searched) && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {facts.map((f) => (
                  <div key={f.label} className="flex min-w-0 items-center gap-3 rounded-lg border border-border px-3 py-2.5"><IconChip icon={f.icon} tone={f.tone} /><div className="min-w-0"><div className="text-[11px] text-subtle">{f.label}</div><div className="truncate text-[13px] font-medium">{f.value}</div></div></div>
                ))}
              </div>
            )}
            {c && c.keywords.length > 0 && <div className="flex flex-wrap gap-1.5">{c.keywords.map((k) => <span key={k} className="rounded-full border border-info/25 bg-info-dim px-2.5 py-0.5 text-[11.5px] text-info">{k}</span>)}</div>}
            {c?.registration && <RegistrationBlock reg={c.registration} />}
            {c?.links && c.links.length > 0 && <CompanyLinks links={c.links} />}
          </div>
        )}

        {tab === 'verify' && s && (
          <div className="flex flex-col gap-3">
            <div className="rounded-xl border border-border px-4 py-3">
              <div className="flex items-baseline justify-between"><span className="text-[13px] font-medium">{passed} of {checks.length} checks passed</span><span className={cn('text-[12px] font-medium', TONE[passed >= 3 ? 'ok' : passed >= 2 ? 'warn' : 'danger'].text)}>{passed >= 3 ? 'Strong' : passed >= 2 ? 'Fair' : 'Weak'}</span></div>
              <div className="mt-2 flex gap-1">{checks.map((x, i) => <span key={i} className={cn('h-1.5 flex-1 rounded-full', x.ok ? 'bg-ok' : x.ok === false ? 'bg-warn' : 'bg-surface-3')} />)}</div>
            </div>
            <ul className="flex flex-col gap-2">
              {checks.map((x) => (
                <li key={x.label} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
                  <IconChip icon={x.icon} tone={x.ok ? 'ok' : x.ok === false ? 'warn' : 'neutral'} />
                  <div className="min-w-0 flex-1"><div className="text-[13px] font-medium">{x.label}</div><div className="truncate text-[11.5px] text-subtle">{x.detail}</div></div>
                  <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', x.ok ? 'bg-ok-dim text-ok' : x.ok === false ? 'bg-warn-dim text-warn' : 'bg-surface-3 text-subtle')}>{x.ok ? <><Check className="size-3" strokeWidth={3} />Passed</> : x.ok === false ? 'Not passed' : <><Minus className="size-3" />Unknown</>}</span>
                </li>
              ))}
            </ul>
            <p className="flex items-start gap-2 text-[11.5px] text-subtle"><EyeOff className="mt-0.5 size-3.5 shrink-0" />Checks are yes/no only — the email address, phone number and website stay hidden until purchase.</p>
          </div>
        )}

        {tab === 'ask' && <AskCompany leadId={row.id} name={name} key={row.id} />}

        {!canRequest && <p className="text-[11.5px] text-subtle"><Phone className="mr-1 inline size-3" />Ask a workspace admin to request leads.</p>}
      </div>
    </Drawer>
  );
}

const STEP_LABEL: Record<PriceStep['kind'], string> = { base: 'Base', info: 'Information', research: 'Research', rule: 'Rule', age: 'Age', transfers: 'Resale', limit: 'Limit' };

/** How a lead's price was worked out — every step, in order. Shared by the marketplace and the admin price tester. */
export function PriceBreakdown({ steps, total, currency, title = 'How this price is calculated' }: { steps: PriceStep[]; total: number; currency: string; title?: string }) {
  const sign = (n: number) => (n < 0 ? `−${money(-n, currency)}` : `+${money(n, currency)}`);
  return (
    <section>
      <div className="eyebrow mb-2">{title}</div>
      <div className="rounded-lg border border-border bg-surface">
        <ul className="flex flex-col divide-y divide-border">
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-3 px-3.5 py-2 text-[12.5px]">
              <span className="w-[74px] shrink-0 text-[10.5px] font-medium tracking-wide text-subtle uppercase">{STEP_LABEL[s.kind]}</span>
              <span className="min-w-0 flex-1 truncate text-fg-2">{s.label}{s.detail && <span className="text-subtle"> · {s.detail}</span>}</span>
              <span className={cn('tnum shrink-0 font-medium', s.kind === 'base' ? 'text-fg' : s.deltaCents < 0 ? 'text-muted' : 'text-fg')}>{s.kind === 'base' ? money(s.deltaCents, currency) : sign(s.deltaCents)}</span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t border-border-strong px-3.5 py-2.5 text-[13px]"><span className="font-medium">Price</span><span className="tnum font-semibold">{money(total, currency)}</span></div>
      </div>
    </section>
  );
}

const SUGGESTED = ['What does this company do?', 'What products or services do they offer?', 'How big is the company?', 'Which industry and markets do they serve?', 'How long have they been in business?'];

/** Ask AI about the company — company basics only; people and contact details are always withheld. */
function AskCompany({ leadId, name }: { leadId: string; name: string | null }) {
  const [msgs, setMsgs] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const history = msgs.slice(-6);
    setMsgs((m) => [...m, { role: 'user', text }]);
    setQ('');
    setBusy(true);
    try {
      const r = await api<{ answer: string }>(`/api/v1/marketplace/leads/${leadId}/ask`, { body: { question: text, history } });
      setMsgs((m) => [...m, { role: 'assistant', text: r.answer }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', text: errorMessage(e) }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <div className="mb-2 flex items-center justify-between"><span className="eyebrow flex items-center gap-1.5"><Bot className="size-3.5" />Ask AI about {name ?? 'this company'}</span><span className="flex items-center gap-1 text-[10.5px] text-subtle"><ShieldCheck className="size-3" />No people or contact details</span></div>
      <div className="rounded-lg border border-border bg-surface">
        {msgs.length > 0 && (
          <div className="flex max-h-72 flex-col gap-3 overflow-y-auto px-3.5 py-3">
            {msgs.map((m, i) => (
              <div key={i} className={cn('flex gap-2', m.role === 'user' && 'justify-end')}>
                {m.role === 'assistant' && <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-fg text-inverse"><Sparkles className="size-3" /></span>}
                <div className={cn('max-w-[85%] text-[12.5px] leading-relaxed whitespace-pre-line', m.role === 'user' ? 'rounded-md border border-border bg-surface-3 px-2.5 py-1.5' : 'pt-0.5 text-fg-2')}>{m.text}</div>
              </div>
            ))}
            {busy && <div className="flex items-center gap-2 text-[12px] text-subtle"><Loader2 className="size-3.5 animate-spin" />Looking into it…</div>}
          </div>
        )}
        {msgs.length === 0 && (
          <div className="flex flex-wrap gap-1.5 px-3.5 pt-3">
            {SUGGESTED.map((s) => <button key={s} type="button" onClick={() => ask(s)} className="rounded-md border border-border px-2 py-1 text-[11.5px] text-muted hover:border-border-strong hover:text-fg">{s}</button>)}
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); void ask(q); }} className="flex items-center gap-2 px-3.5 py-3">
          <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} placeholder="Ask about the business…" aria-label="Ask about the company" className="h-8 min-w-0 flex-1 rounded-md border border-border-strong bg-surface-2 px-2.5 text-[12.5px] outline-none focus:border-fg/40" />
          <button type="submit" disabled={busy || q.trim().length < 2} aria-label="Ask" className="grid size-8 shrink-0 place-items-center rounded-md bg-fg text-inverse disabled:opacity-40"><ArrowUp className="size-4" /></button>
        </form>
      </div>
    </section>
  );
}

type Quota = { enabled: boolean; used: number; limit: number };

/** "Research this company" — reads the company's public website once; the result is kept for everyone. */
export function ResearchCta({ leadId, onDone, endpoint }: { leadId: string; onDone?: (c: CompanyPreview | null) => void; endpoint?: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ status: string; reused: boolean; company: CompanyPreview | null; quota: Quota }>(endpoint ?? `/api/v1/marketplace/leads/${leadId}/research`, { method: 'POST' });
      setQuota(r.quota);
      if (r.status !== 'DONE') setMsg('We couldn’t find a public website for this company, so only basic checks are available. The result is saved, so nobody needs to research it again.');
      onDone?.(r.company);
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-3 rounded-lg border border-dashed border-border-strong px-4 py-4">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-3"><Search className="size-4 text-muted" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">This company hasn’t been researched yet</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">Research reads the company’s public website and builds a profile — what it does, size, history and markets. It takes up to 30 seconds and is saved, so it’s instant for everyone next time.</p>
          {msg && <p className="mt-2 text-[12px] text-warn">{msg}</p>}
          <div className="mt-3 flex items-center gap-3">
            <Button size="sm" variant="primary" loading={busy} onClick={run}>{busy ? 'Researching…' : <><Sparkles /> Research this company</>}</Button>
            {busy && <span className="text-[11.5px] text-subtle">Reading the company’s website…</span>}
            {!busy && quota && <span className="text-[11.5px] text-subtle">{Math.max(0, quota.limit - quota.used)} of {quota.limit} research credits left today</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
