'use client';
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, Clock, CornerDownLeft, Gift, Inbox, Lock, Mail, MapPin, Phone, RotateCcw, ShieldCheck, Sparkles, Target,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { BrandMark, logoText } from '@/components/shell/brand';
import { cn } from '@/lib/cn';
import type { Homepage } from '@/lib/homepage';
import type { Viewer } from './homepage-view';
import { PublicFormView, type Brand, type PublicFormData } from './public-form';

type Action = { type: string; [k: string]: unknown };
type QuickReply = { label: string; action?: Action; message?: string };
type Masked = { ref: string; industry: string | null; country: string | null; state: string | null; seniority: string | null; score: number | null; fresh: boolean; hasEmail: boolean; hasPhone: boolean; addedDays: number };
type Results = { total: number; avgScore: number; withEmail: number; withPhone: number; fresh: number; breakdown: { industries: { label: string; count: number }[]; regions: { label: string; count: number }[] }; sample: Masked[]; claimable: number };
type Turn = { reply: string; criteria: unknown; chips: string[]; quickReplies: QuickReply[]; faq: readonly { id: string; q: string }[]; results: Results | null; free: number; engine: string };
type Msg = { id: number; role: 'user' | 'assistant'; text: string; results?: Results | null; quick?: QuickReply[] };
export type Headline = { total: number; industries: number; regions: number; free: number };

const FONTS: Record<string, string> = {
  geist: 'var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif',
  inter: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  mono: 'var(--font-geist-mono), ui-monospace, monospace',
};
function onAccent(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#0b0b0b' : '#ffffff';
}
const fmt = (n: number) => n.toLocaleString('en-US');
const primary = { background: 'var(--fa)', color: 'var(--fa-fg)' } as const;

/** `*word*` is set in the secondary ink (or the accent in brand style). */
function Rich({ text, brand }: { text: string; brand: boolean }) {
  return <>{text.split('*').map((p, i) => (i % 2 ? <span key={i} className={brand ? '' : 'text-muted'} style={brand ? { color: 'var(--fa)' } : undefined}>{p}</span> : <Fragment key={i}>{p}</Fragment>))}</>;
}

/** Tiny markdown: **bold** and bullet lines. */
function Md({ text }: { text: string }) {
  const inline = (l: string) => l.split('**').map((p, i) => (i % 2 ? <strong key={i} className="font-medium text-fg">{p}</strong> : <Fragment key={i}>{p}</Fragment>));
  return (
    <div className="flex flex-col gap-1.5">
      {text.split('\n').map((l, i) => /^\s*[•\-]\s/.test(l)
        ? <div key={i} className="flex gap-2.5"><span className="mt-[9px] size-1 shrink-0 rounded-full bg-subtle" /><span>{inline(l.replace(/^\s*[•\-]\s/, ''))}</span></div>
        : l.trim() ? <p key={i}>{inline(l)}</p> : null)}
    </div>
  );
}

const Chip = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
  <button type="button" onClick={onClick} className="inline-flex h-7 items-center rounded-md border border-border bg-surface px-2.5 text-[12px] text-muted transition-colors hover:border-border-strong hover:text-fg">{children}</button>
);

const Bar = ({ label, count, max }: { label: string; count: number; max: number }) => (
  <div className="flex items-center gap-3 text-[12px]">
    <span className="w-[40%] truncate text-fg-2">{label}</span>
    <span className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3"><span className="block h-full rounded-full bg-fg/70 transition-[width] duration-700" style={{ width: `${Math.max(3, (count / Math.max(1, max)) * 100)}%` }} /></span>
    <span className="tnum w-12 text-right text-muted">{fmt(count)}</span>
  </div>
);

const LeadRow = ({ l }: { l: Masked }) => (
  <li className="flex items-center gap-3 px-4 py-3">
    <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-surface-2 text-subtle"><Lock className="size-3.5" /></span>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2"><span className="h-2 w-20 rounded-full bg-fg/12" /><span className="h-2 w-12 rounded-full bg-fg/8" /></div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted">
        <span className="text-fg-2">{[l.seniority, l.industry].filter(Boolean).join(' · ') || 'Verified contact'}</span>
        {(l.state || l.country) && <span className="inline-flex items-center gap-1"><MapPin className="size-3" />{[l.state, l.country].filter(Boolean).join(', ')}</span>}
        <span className={cn('inline-flex items-center gap-1', !l.hasEmail && 'text-faint line-through')}><Mail className="size-3" />Email</span>
        <span className={cn('inline-flex items-center gap-1', !l.hasPhone && 'text-faint line-through')}><Phone className="size-3" />Phone</span>
      </div>
    </div>
    <div className="flex shrink-0 flex-col items-end gap-1">
      {l.score ? <span className="tnum rounded border border-border-strong px-1.5 text-[11px] leading-5 font-medium">{l.score}</span> : null}
      <span className="text-[10.5px] text-subtle">{l.fresh ? 'Exclusive' : l.addedDays === 0 ? 'Today' : `${l.addedDays}d ago`}</span>
    </div>
  </li>
);

export function FinderHome({ form, homepage, brand, headline, viewer = null, preview = false, className }: { form: PublicFormData; homepage: Homepage; brand: Brand; headline: Headline; viewer?: Viewer; preview?: boolean; className?: string }) {
  const d = form.config.design;
  const f = homepage.finder;
  const branded = f.style === 'brand';
  const theme = branded && d.theme !== 'auto' ? d.theme : undefined;
  const vars = {
    fontFamily: branded ? FONTS[d.font] : FONTS.geist,
    ...({ '--fa': branded ? d.accent : 'var(--fg)', '--fa-fg': branded ? onAccent(d.accent) : 'var(--inverse)' } as React.CSSProperties),
  };
  const fill = (s: string) => s.replaceAll('{free}', String(headline.free)).replaceAll('{count}', fmt(headline.total));
  const mark = { productName: brand.productName, shortName: brand.shortName, tagline: '', logoUrl: form.assets.logo ?? brand.logoUrl, logoDarkUrl: form.assets.logo ? null : brand.logoDarkUrl, showNameWithLogo: true };

  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [criteria, setCriteria] = useState<unknown>(undefined);
  const [chips, setChips] = useState<string[]>([]);
  const [results, setResults] = useState<Results | null>(null);
  const [faq, setFaq] = useState<readonly { id: string; q: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [panel, setPanel] = useState<'results' | 'claim' | 'done'>('results');
  const [done, setDone] = useState<{ activated: boolean; email: string; name: string } | null>(null);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const started = msgs.length > 0;

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [msgs, busy]);

  const send = async (message: string | null, action: Action | null = null, label?: string) => {
    if (busy) return;
    const text = message ?? label ?? null;
    const history = msgs.slice(-12).map((m) => ({ role: m.role, text: m.text.slice(0, 2000) }));
    if (text) setMsgs((m) => [...m.map((x) => ({ ...x, quick: undefined })), { id: ++seq.current, role: 'user', text }]);
    setInput('');
    setBusy(true);
    setPanel((p) => (p === 'done' ? p : 'results'));
    try {
      const res = await fetch('/api/v1/public/home/finder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, action, criteria, history }) });
      if (!res.ok) throw new Error(res.status === 429 ? 'You’re going a little fast — give it a few seconds and try again.' : 'I couldn’t reach the lead catalog just now. Please try again.');
      const t = (await res.json()) as Turn;
      setCriteria(t.criteria);
      setChips(t.chips);
      setFaq(t.faq);
      if (t.results) setResults(t.results);
      if (action?.type === 'reset') setResults(null);
      setMsgs((m) => [...m, { id: ++seq.current, role: 'assistant', text: t.reply, results: t.results, quick: t.quickReplies }]);
    } catch (e) {
      setMsgs((m) => [...m, { id: ++seq.current, role: 'assistant', text: e instanceof Error ? e.message : 'Something went wrong.' }]);
    } finally {
      setBusy(false);
    }
  };
  const submit = () => { const t = input.trim(); if (t) void send(t); };
  const quick = (q: QuickReply) => (q.message ? send(q.message) : send(null, q.action ?? null, q.label));
  const claim = () => { if (viewer) { window.location.href = viewer.dashboardHref === '/app' ? '/app/marketplace' : viewer.dashboardHref; return; } setPanel('claim'); };
  const reset = () => { setMsgs([]); setResults(null); setCriteria(undefined); setChips([]); setPanel('results'); };
  const claimable = results ? Math.min(headline.free, results.total) : headline.free;

  // ── Pieces (render functions, so inputs keep focus across renders) ──

  const composer = (big: boolean) => (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}
      className="w-full rounded-xl border border-border-strong bg-surface shadow-[var(--raised-shadow)] transition-colors focus-within:border-fg/40">
      <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={big ? 3 : 1} maxLength={1000} aria-label="Describe the leads you want"
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
        placeholder={big ? f.placeholder : 'Refine the search or ask a question…'}
        className={cn('block w-full resize-none bg-transparent text-fg outline-none placeholder:text-subtle', big ? 'min-h-[84px] px-4 pt-3.5 text-[14.5px] leading-relaxed' : 'max-h-32 px-3.5 pt-3 text-[14px]')} />
      <div className="flex items-center gap-3 px-3 pt-1 pb-2.5">
        <span className="flex items-center gap-1.5 text-[11.5px] text-subtle"><Sparkles className="size-3" />AI search · live inventory</span>
        <span className="ml-auto hidden items-center gap-1 text-[11px] text-faint @md:flex"><CornerDownLeft className="size-3" />to search</span>
        <button type="submit" disabled={busy || !input.trim()} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-opacity hover:opacity-90 disabled:opacity-35 @md:ml-0" style={primary}>
          Search<ArrowRight className="size-3.5" />
        </button>
      </div>
    </form>
  );

  const claimCard = () => (
    <div className="rounded-xl p-4" style={primary}>
      <div className="flex items-start gap-3">
        <Gift className="mt-0.5 size-4 shrink-0 opacity-80" />
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium">{claimable ? `Your first ${claimable} lead${claimable === 1 ? ' is' : 's are'} free` : 'Create your workspace'}</div>
          <div className="mt-0.5 text-[12px] opacity-65">No payment or card required. Delivered to your private dashboard.</div>
        </div>
      </div>
      <button type="button" onClick={claim} className="mt-3.5 flex h-9 w-full items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-opacity hover:opacity-90" style={{ background: 'var(--fa-fg)', color: 'var(--fa)' }}>
        {viewer ? 'Request in your dashboard' : f.claimLabel}<ArrowRight className="size-3.5" />
      </button>
    </div>
  );

  const resultsPanel = (r: Results) => {
    const maxI = Math.max(1, ...r.breakdown.industries.map((x) => x.count));
    const maxR = Math.max(1, ...r.breakdown.regions.map((x) => x.count));
    const pct = (n: number) => (r.total ? `${Math.round((n / r.total) * 100)}%` : '—');
    return (
      <div className="flex flex-col gap-3">
        <section className="rounded-xl border border-border bg-surface">
          <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="relative flex size-1.5"><span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-60" /><span className="relative size-1.5 rounded-full bg-ok" /></span>
            <span className="text-[12.5px] font-medium">Live matches</span>
            <span className="ml-auto text-[11px] text-subtle">Contact details hidden</span>
          </header>
          <div className="px-4 pt-4 pb-3">
            <div className="flex items-baseline gap-2"><span className="tnum text-[32px] leading-none font-[560] tracking-[-0.035em]">{fmt(r.total)}</span><span className="text-[12.5px] text-muted">leads match your search</span></div>
          </div>
          <dl className="grid grid-cols-4 divide-x divide-border border-t border-border">
            {[['Avg score', r.avgScore || '—'], ['Email', pct(r.withEmail)], ['Phone', pct(r.withPhone)], ['Exclusive', pct(r.fresh)]].map(([k, v]) => (
              <div key={k as string} className="px-3 py-2.5"><dt className="eyebrow !text-[9.5px]">{k}</dt><dd className="tnum mt-1 text-[14px] font-medium">{v}</dd></div>
            ))}
          </dl>
          {(r.breakdown.industries.length > 0 || r.breakdown.regions.length > 0) && (
            <div className="flex flex-col gap-2 border-t border-border px-4 py-3.5">
              {r.breakdown.industries.slice(0, 3).map((x) => <Bar key={`i${x.label}`} label={x.label} count={x.count} max={maxI} />)}
              {r.breakdown.regions.slice(0, 4).map((x) => <Bar key={`r${x.label}`} label={x.label} count={x.count} max={maxR} />)}
            </div>
          )}
        </section>
        {r.total > 0 && claimCard()}
        {r.sample.length > 0 && (
          <section className="rounded-xl border border-border bg-surface">
            <header className="flex items-center justify-between border-b border-border px-4 py-2.5"><span className="text-[12.5px] font-medium">Top matches</span><span className="text-[11px] text-subtle">Unlocks after sign-up</span></header>
            <ul className="divide-y divide-border">{r.sample.map((l) => <LeadRow key={l.ref} l={l} />)}</ul>
          </section>
        )}
      </div>
    );
  };

  const stepper = (n: 1 | 2 | 3) => (
    <ol className="flex items-center gap-2 text-[12px]">
      {['Search', 'Your details', 'Free leads'].map((s, i) => (
        <li key={s} className="flex min-w-0 flex-1 items-center gap-2">
          <span className={cn('grid size-5 shrink-0 place-items-center rounded-full border text-[10.5px] font-semibold', i + 1 <= n ? 'border-transparent' : 'border-border-strong text-subtle')} style={i + 1 <= n ? primary : undefined}>{i + 1 < n ? <Check className="size-3" strokeWidth={3} /> : i + 1}</span>
          <span className={cn('truncate', i + 1 === n ? 'font-medium text-fg' : 'text-subtle')}>{s}</span>
          {i < 2 && <span className="h-px min-w-3 flex-1 bg-border" />}
        </li>
      ))}
    </ol>
  );

  const claimPanel = (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={() => setPanel('results')} className="flex items-center gap-1.5 self-start text-[12.5px] text-muted hover:text-fg"><ArrowLeft className="size-3.5" />Back to results</button>
      {stepper(2)}
      <section className="rounded-xl border border-border bg-surface px-4 py-3.5">
        <div className="eyebrow">Your search</div>
        <div className="mt-2 flex flex-wrap gap-1.5">{(chips.length ? chips : ['Any leads']).map((c) => <span key={c} className="inline-flex h-6 items-center rounded border border-border-strong bg-surface-3 px-2 text-[11.5px] text-fg-2">{c}</span>)}</div>
        <p className="mt-2.5 text-[12.5px] text-muted"><span className="font-medium text-fg">{claimable} free leads</span> from {results ? fmt(results.total) : 'these'} matches go straight to your dashboard.</p>
      </section>
      <div>
        <h2 className="text-[18px] font-[560] tracking-[-0.025em]">Create your workspace</h2>
        <p className="mt-1 mb-4 text-[12.5px] text-muted">No payment or card needed. We’ll email you a secure link to your dashboard.</p>
        <PublicFormView form={form} brand={brand} preview={preview} embedded monochrome={!branded} presetInterests={{ criteria, summary: chips.join(', '), matches: results?.total ?? undefined }}
          onDone={(r) => { setDone(r); setPanel('done'); }} />
      </div>
    </div>
  );

  const donePanel = done && (
    <div className="flex flex-col gap-4">
      {stepper(3)}
      <section className="rounded-xl border border-border bg-surface px-5 py-6 text-center">
        <span className="animate-pop mx-auto grid size-11 place-items-center rounded-full" style={primary}><Check className="size-5" strokeWidth={2.5} /></span>
        <h2 className="mt-4 text-[18px] font-[560] tracking-[-0.025em]">{done.name ? `You’re in, ${done.name.split(' ')[0]}` : 'You’re in'}</h2>
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">{done.activated ? `Your workspace is ready. Check ${done.email || 'your inbox'} for your secure sign-in link.` : `Your search is saved and your details received. We’ll email ${done.email || 'you'} as soon as your workspace is active.`}</p>
      </section>
      <section className="rounded-xl border border-border bg-surface">
        <header className="border-b border-border px-4 py-2.5 text-[12.5px] font-medium">What happens next</header>
        <ol className="flex flex-col px-4 py-4">
          {[
            { icon: Target, title: 'Search saved', text: chips.join(' · ') || 'Your ideal leads', ok: true },
            { icon: CheckCircle2, title: 'Details received', text: 'No payment information required', ok: true },
            { icon: done.activated ? ShieldCheck : Clock, title: done.activated ? 'Workspace activated' : 'Workspace activation', text: done.activated ? 'Ready when you set your password' : 'Usually within one business day', ok: done.activated },
            { icon: Inbox, title: `${claimable} free leads delivered`, text: 'Waiting in your dashboard at first sign-in', ok: false },
          ].map((s, i, arr) => (
            <li key={s.title} className="relative flex gap-3 pb-4 last:pb-0">
              {i < arr.length - 1 && <span className="absolute top-7 bottom-0 left-[13px] w-px bg-border" aria-hidden />}
              <span className={cn('relative grid size-[27px] shrink-0 place-items-center rounded-full border', s.ok ? 'border-transparent' : 'border-border-strong bg-surface text-muted')} style={s.ok ? primary : undefined}><s.icon className="size-3.5" /></span>
              <span className="pt-0.5"><span className="block text-[13px] font-medium">{s.title}</span><span className="block text-[12px] text-muted">{s.text}</span></span>
            </li>
          ))}
        </ol>
      </section>
      <button type="button" onClick={() => setPanel('results')} className="flex items-center justify-center gap-1.5 text-[12.5px] text-muted hover:text-fg"><ArrowLeft className="size-3.5" />Back to my search</button>
    </div>
  );

  const stats = [
    [fmt(headline.total), 'Verified leads'],
    headline.industries ? [String(headline.industries), 'Industries'] : null,
    headline.regions ? [String(headline.regions), 'Regions'] : null,
    headline.free ? [String(headline.free), 'Free to start'] : null,
  ].filter(Boolean) as [string, string][];

  return (
    <div id="top" data-theme={theme} className={cn('@container relative isolate flex w-full flex-col bg-bg text-fg antialiased', className)} style={vars}
      onClickCapture={preview ? (e) => { const a = (e.target as HTMLElement).closest('a'); if (a && !(a.getAttribute('href') ?? '').startsWith('#')) e.preventDefault(); } : undefined}>
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>
        {(f.background === 'grid' || f.background === 'aurora') && <div className="grid-backdrop absolute inset-x-0 top-0 h-[760px]" />}
        {(f.background === 'glow' || f.background === 'aurora') && <div className="absolute inset-x-0 top-0 h-[640px]" style={{ background: `radial-gradient(55% 50% at 50% 0%, color-mix(in oklab, var(--fa) ${branded ? 16 : 7}%, transparent), transparent 75%)` }} />}
      </div>

      <header className="sticky top-0 z-20 border-b border-border bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-5 @3xl:px-8">
          <a href="#top" className="flex min-w-0 items-center gap-2.5"><BrandMark brand={mark} size={24} />{!mark.logoUrl && <span className="truncate text-[13px] font-semibold tracking-[-0.02em]">{logoText(brand.productName)}</span>}</a>
          <div className="ml-auto flex items-center gap-1">
            {started && <button type="button" onClick={reset} className="hidden h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-muted hover:bg-surface-3 hover:text-fg @md:inline-flex"><RotateCcw className="size-3.5" />New search</button>}
            {viewer ? <a href={viewer.dashboardHref} className="inline-flex h-8 items-center rounded-md px-3 text-[12.5px] font-medium" style={primary}>Open dashboard</a>
              : homepage.nav.showSignIn && <a href="/login" className="inline-flex h-8 items-center rounded-md border border-border-strong bg-surface-3 px-3 text-[12.5px] font-medium hover:bg-hover">{homepage.nav.signInLabel}</a>}
          </div>
        </div>
      </header>

      {!started ? (
        <main className="relative mx-auto flex w-full max-w-[720px] flex-1 flex-col items-center justify-center px-5 pt-14 pb-20 text-center @3xl:pt-20">
          {f.eyebrow && (
            <span className="animate-fade-in mb-6 inline-flex h-7 items-center gap-2 rounded-full border border-border-strong bg-surface px-3 text-[12px] font-medium text-fg-2">
              <span className="size-1.5 rounded-full bg-ok" />{fill(f.eyebrow)}
            </span>
          )}
          <h1 className="text-[34px] leading-[1.06] font-[560] tracking-[-0.035em] text-balance @2xl:text-[46px] @5xl:text-[54px]"><Rich text={fill(f.title)} brand={branded} /></h1>
          {f.subtitle && <p className="mt-4 max-w-xl text-[14.5px] leading-relaxed text-pretty text-muted @3xl:text-[15.5px]">{fill(f.subtitle)}</p>}
          <div className="mt-9 w-full text-left">{composer(true)}</div>
          {f.suggestions.length > 0 && <div className="mt-3.5 flex flex-wrap justify-center gap-1.5">{f.suggestions.map((s) => <Chip key={s} onClick={() => send(s)}>{s}</Chip>)}</div>}
          {f.trust.length > 0 && (
            <div className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-[12.5px] text-muted">
              {f.trust.map((t) => <span key={t} className="flex items-center gap-1.5"><Check className="size-3.5 text-fg" strokeWidth={2.5} />{t}</span>)}
            </div>
          )}
          {f.showStats && headline.total > 0 && (
            <dl className={cn('mt-12 grid w-full grid-cols-2 overflow-hidden rounded-xl border border-border bg-surface text-left', stats.length === 3 ? '@2xl:grid-cols-3' : stats.length === 4 ? '@2xl:grid-cols-4' : '')}>
              {stats.map(([v, l], i) => (
                <div key={l} className={cn('border-border px-4 py-3.5', i % 2 === 1 && 'border-l', i >= 2 && 'border-t @2xl:border-t-0', i === 2 && '@2xl:border-l')}>
                  <dt className="eyebrow">{l}</dt><dd className="tnum mt-2 text-[22px] leading-none font-[520] tracking-[-0.03em]">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {f.showFaq && (
            <div className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-[12px]">
              {[['free', 'Are the first leads really free?'], ['how', 'How does it work?'], ['visibility', 'What can I see before signing up?']].map(([id, q]) => <button key={id} type="button" onClick={() => send(null, { type: 'faq', id }, q)} className="text-subtle underline-offset-4 hover:text-fg hover:underline">{q}</button>)}
            </div>
          )}
        </main>
      ) : (
        <main className="relative mx-auto grid grid-cols-1 w-full max-w-6xl flex-1 gap-6 px-5 pt-5 pb-4 @3xl:px-8 @5xl:grid-cols-[minmax(0,1fr)_380px] @5xl:gap-8">
          <section className={cn('min-h-0 flex-col', panel === 'results' ? 'flex' : 'hidden @5xl:flex')}>
            {chips.length > 0 && (
              <div className="mb-4 flex flex-wrap items-center gap-1.5">
                <span className="eyebrow mr-1">Searching</span>
                {chips.map((c) => <span key={c} className="inline-flex h-6 items-center rounded border border-border-strong bg-surface-3 px-2 text-[11.5px] font-medium text-fg-2">{c}</span>)}
              </div>
            )}
            <div ref={listRef} className="flex max-h-[calc(100dvh-220px)] min-h-[320px] flex-1 flex-col gap-6 overflow-y-auto pr-1 pb-4 [scrollbar-width:thin]">
              {msgs.map((m, idx) => (
                <div key={m.id} className={cn('animate-fade-in flex gap-3', m.role === 'user' && 'justify-end')}>
                  {m.role === 'assistant' && <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md" style={primary}><Sparkles className="size-3.5" /></span>}
                  <div className={cn('flex max-w-[86%] flex-col gap-3', m.role === 'user' && 'items-end')}>
                    {m.role === 'assistant'
                      ? <div className="pt-1 text-[14px] leading-[1.65] text-fg-2"><Md text={m.text} /></div>
                      : <div className="rounded-lg border border-border bg-surface-3 px-3.5 py-2 text-[14px] text-fg">{m.text}</div>}
                    {m.results && idx === msgs.length - 1 && m.results.total > 0 && (
                      <div className="flex w-full flex-col gap-3 @5xl:hidden">
                        <section className="rounded-xl border border-border bg-surface">
                          <div className="flex items-baseline gap-2 px-4 py-3"><span className="tnum text-[26px] leading-none font-[560] tracking-[-0.035em]">{fmt(m.results.total)}</span><span className="text-[12px] text-muted">matches{m.results.avgScore ? ` · avg score ${m.results.avgScore}` : ''}</span></div>
                          <ul className="divide-y divide-border border-t border-border">{m.results.sample.slice(0, 3).map((l) => <LeadRow key={l.ref} l={l} />)}</ul>
                        </section>
                        {claimCard()}
                      </div>
                    )}
                    {m.quick && m.quick.length > 0 && idx === msgs.length - 1 && !busy && <div className="flex flex-wrap gap-1.5">{m.quick.map((q) => <Chip key={q.label} onClick={() => quick(q)}>{q.label}</Chip>)}</div>}
                  </div>
                </div>
              ))}
              {busy && (
                <div className="flex gap-3"><span className="grid size-7 shrink-0 place-items-center rounded-md" style={primary}><Sparkles className="size-3.5" /></span>
                  <div className="home-typing flex items-center gap-1 pt-2.5">{[0, 1, 2].map((i) => <span key={i} className="size-1.5 rounded-full bg-subtle" />)}<span className="sr-only">Searching</span></div></div>
              )}
            </div>
            <div className="sticky bottom-0 bg-gradient-to-t from-bg via-bg to-transparent pt-3 pb-1">
              {composer(false)}
              {faq.length > 0 && <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11.5px] text-subtle">{faq.slice(0, 3).map((q) => <button key={q.id} type="button" onClick={() => send(null, { type: 'faq', id: q.id }, q.q)} className="hover:text-fg">{q.q}</button>)}</div>}
            </div>
          </section>

          <aside className={cn('min-h-0 @5xl:sticky @5xl:top-[72px] @5xl:block @5xl:max-h-[calc(100dvh-88px)] @5xl:self-start @5xl:overflow-y-auto @5xl:pb-6 [scrollbar-width:thin]', panel === 'results' ? 'hidden' : 'block')}>
            {panel === 'claim' ? claimPanel : panel === 'done' ? donePanel : results ? resultsPanel(results) : (
              <div className="flex min-h-[340px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong p-8 text-center">
                <Target className="size-5 text-subtle" />
                <div className="mt-1 text-[13px] font-medium">Matches appear here</div>
                <p className="max-w-[240px] text-[12px] text-muted">Answer a question or two and live matches show up — your first {headline.free} are free.</p>
              </div>
            )}
          </aside>
        </main>
      )}

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-5 gap-y-1 px-5 py-4 text-[11.5px] text-subtle @3xl:justify-between @3xl:px-8">
          <span>{homepage.footer.text}</span>
          <span className="flex flex-wrap items-center gap-x-5 gap-y-1">
            {homepage.footer.links.map((l, i) => <a key={i} href={l.href} className="hover:text-fg">{l.label}</a>)}
            <span className="flex items-center gap-1"><Lock className="size-3" />Contact details stay private until delivered</span>
          </span>
        </div>
      </footer>
    </div>
  );
}
