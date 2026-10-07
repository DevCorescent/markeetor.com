'use client';
import { logoText } from '@/components/shell/brand';
import {
  ArrowRight, BarChart3, Check, CheckCircle2, Clock, Database, Filter, Globe, Handshake, Layers, Mail, Menu, Phone, Plus, Quote, Rocket, ShieldCheck, Sparkles, Star, Target, Trophy, Users, X, Zap,
} from 'lucide-react';
import { Fragment, useState } from 'react';
import { cn } from '@/lib/cn';
import { linkHref, type HomeLink, type HomeSection, type Homepage, type SectionIcon } from '@/lib/homepage';
import { PublicFormView, type Brand, type PublicFormData } from './public-form';

export const SECTION_ICON_MAP: Record<SectionIcon, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  sparkles: Sparkles, shield: ShieldCheck, zap: Zap, target: Target, users: Users, chart: BarChart3, mail: Mail, globe: Globe, clock: Clock,
  check: CheckCircle2, star: Star, rocket: Rocket, database: Database, filter: Filter, layers: Layers, handshake: Handshake, phone: Phone, trophy: Trophy,
};

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

/** `Grow *faster* today` → “faster” in the accent colour. */
function Rich({ text }: { text: string }) {
  const parts = text.split('*');
  return <>{parts.map((p, i) => (i % 2 ? <span key={i} style={{ color: 'var(--fa)' }}>{p}</span> : <Fragment key={i}>{p}</Fragment>))}</>;
}

const tint = (pct: number) => `color-mix(in oklab, var(--fa) ${pct}%, transparent)`;

export type Viewer = { dashboardHref: string } | null;

export function HomepageView({ form, homepage, brand, viewer = null, preview = false, className, frame }: {
  form: PublicFormData; homepage: Homepage; brand: Brand; viewer?: Viewer; preview?: boolean; className?: string;
  /** Builder hook: wraps each rendered section (selection outline, drag handle, toolbar). */
  frame?: (s: HomeSection, node: React.ReactNode) => React.ReactNode;
}) {
  const d = form.config.design;
  const theme = d.theme === 'auto' ? undefined : d.theme;
  const inverse = theme === 'dark' ? 'light' : 'dark';
  const [menu, setMenu] = useState(false);
  const sections = homepage.sections.filter((s) => s.enabled);
  const owner = sections.find((s) => s.type === 'form' || (s.type === 'hero' && (s.layout === 'form-right' || s.layout === 'form-left')))?.id ?? null;
  const formHref = owner ? '#apply' : `/join/${form.slug}`;
  const hrefOf = (l: Pick<HomeLink, 'action' | 'href'>) => (l.action === 'form' ? formHref : linkHref(l));
  const logo = form.assets.logo ?? brand.logoUrl;
  const pill = d.buttonStyle === 'pill';

  const vars = { fontFamily: FONTS[d.font], ...({ '--fa': d.accent, '--fa-fg': onAccent(d.accent), '--fr': `${d.radius}px` } as React.CSSProperties) };

  const btn = ({ l, kind = 'primary', size = 'lg', onDark }: { l: HomeLink; kind?: 'primary' | 'secondary'; size?: 'md' | 'lg'; onDark?: boolean }) => (
    <a href={hrefOf(l)}
      className={cn('group inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap transition-all duration-200', size === 'lg' ? 'h-12 px-6 text-[15px]' : 'h-9 px-4 text-[13.5px]', kind === 'primary' ? 'shadow-[0_8px_24px_-8px_var(--fa)] hover:-translate-y-px hover:brightness-110' : 'border hover:bg-surface-3', kind === 'secondary' && (onDark ? 'border-white/25 hover:bg-white/10' : 'border-border-strong'))}
      style={{ borderRadius: pill ? 999 : 'var(--fr)', ...(kind === 'primary' ? (d.buttonStyle === 'outline' ? { border: '1.5px solid var(--fa)', color: 'var(--fa)', boxShadow: 'none' } : { background: 'var(--fa)', color: 'var(--fa-fg)' }) : {}) }}>
      {l.label}{kind === 'primary' && <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />}
    </a>
  );

  const Brandmark = (
    <a href="#top" className="flex min-w-0 items-center gap-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {logo ? <img src={logo} alt={brand.productName} className="h-7 w-auto max-w-[150px] object-contain" />
        : <span className="grid size-8 shrink-0 place-items-center text-[11.5px] font-bold" style={{ background: 'var(--fa)', color: 'var(--fa-fg)', borderRadius: 'calc(var(--fr) - 2px)' }}>{brand.shortName}</span>}
      {!form.assets.logo && !brand.logoUrl && <span className="truncate text-[15px] font-semibold tracking-[-0.02em]">{logoText(brand.productName)}</span>}
    </a>
  );

  const FormBlock = (
    <div id="apply" className="relative scroll-mt-24">
      <div className="pointer-events-none absolute -inset-8 -z-0 rounded-[48px] opacity-70 blur-3xl" style={{ background: `radial-gradient(closest-side, ${tint(28)}, transparent)` }} aria-hidden />
      <PublicFormView form={form} brand={brand} preview={preview} embedded className="relative" />
    </div>
  );

  const heading = ({ s, inverted }: { s: HomeSection; inverted?: boolean }) => (s.eyebrow || s.title || s.subtitle) ? (
    <div className={cn('mb-12 max-w-2xl @3xl:mb-16', s.align === 'center' ? 'mx-auto text-center' : '')}>
      {s.eyebrow && <div className="mb-3 text-[12.5px] font-semibold tracking-[0.08em] uppercase" style={{ color: inverted ? 'inherit' : 'var(--fa)', opacity: inverted ? 0.75 : 1 }}>{s.eyebrow}</div>}
      {s.title && <h2 className="text-[30px] leading-[1.08] font-semibold tracking-[-0.035em] text-balance @3xl:text-[42px]"><Rich text={s.title} /></h2>}
      {s.subtitle && <p className={cn('mt-4 text-[15.5px] leading-relaxed text-pretty @3xl:text-[17px]', inverted ? 'opacity-75' : 'text-muted')}>{s.subtitle}</p>}
    </div>
  ) : null;

  const body = (s: HomeSection) => {
    const cols = { 1: '', 2: '@3xl:grid-cols-2', 3: '@3xl:grid-cols-2 @5xl:grid-cols-3', 4: '@3xl:grid-cols-2 @5xl:grid-cols-4' }[s.columns] ?? '';
    const accentBg = s.background === 'accent';
    switch (s.type) {
      case 'hero': {
        const withForm = s.id === owner && (s.layout === 'form-right' || s.layout === 'form-left');
        const centered = s.layout === 'centered' || (!withForm && s.layout !== 'split-image');
        const copy = (
          <div className={cn('relative', centered && 'mx-auto max-w-3xl text-center')}>
            {s.eyebrow && (
              <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-border-strong bg-surface/70 py-1 pr-3.5 pl-1.5 text-[12.5px] font-medium backdrop-blur">
                <span className="grid size-5 place-items-center rounded-full" style={{ background: 'var(--fa)', color: 'var(--fa-fg)' }}><Sparkles className="size-3" /></span>{s.eyebrow}
              </span>
            )}
            <h1 className="text-[38px] leading-[1.02] font-semibold tracking-[-0.045em] text-balance @3xl:text-[54px] @6xl:text-[64px]"><Rich text={s.title} /></h1>
            {s.subtitle && <p className={cn('mt-5 text-[16.5px] leading-relaxed text-pretty text-muted @3xl:text-[19px]', centered && 'mx-auto max-w-2xl')}>{s.subtitle}</p>}
            {s.items.length > 0 && (
              <ul className={cn('mt-7 gap-3', centered ? 'flex flex-wrap justify-center gap-x-6' : 'grid')}>
                {s.items.map((x) => <li key={x.id} className="flex items-start gap-2.5 text-[14.5px] text-fg-2"><span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full" style={{ background: tint(16), color: 'var(--fa)' }}><Check className="size-3" strokeWidth={3} /></span>{x.title}</li>)}
              </ul>
            )}
            {(s.primary || s.secondary) && (
              <div className={cn('mt-8 flex flex-wrap gap-3', centered && 'justify-center')}>
                {s.primary && btn({ l: s.primary })}{s.secondary && btn({ l: s.secondary, kind: 'secondary' })}
              </div>
            )}
          </div>
        );
        if (withForm) return <div className="grid grid-cols-1 items-center gap-12 @4xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] @6xl:gap-20">{s.layout === 'form-left' ? <>{FormBlock}{copy}</> : <>{copy}{FormBlock}</>}</div>;
        if (s.layout === 'split-image') return (
          <div className="grid grid-cols-1 items-center gap-12 @4xl:grid-cols-2">
            {copy}
            <div className="relative aspect-[4/3] overflow-hidden border border-border shadow-2xl" style={{ borderRadius: 'calc(var(--fr) + 12px)', background: form.assets.cover ? `center/cover url(${form.assets.cover})` : `linear-gradient(135deg, ${tint(35)}, ${tint(6)})` }}>
              {!form.assets.cover && <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-10">{[100, 78, 56, 38, 22].map((w, i) => <div key={i} className="h-6 rounded-md" style={{ width: `${w}%`, background: 'var(--fa)', opacity: 0.9 - i * 0.15 }} />)}</div>}
            </div>
          </div>
        );
        return (
          <>
            {copy}
            {form.assets.cover && <div className="relative mx-auto mt-14 max-w-5xl overflow-hidden border border-border shadow-2xl" style={{ borderRadius: 'calc(var(--fr) + 12px)' }}>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={form.assets.cover} alt="" className="w-full object-cover" /></div>}
          </>
        );
      }
      case 'logos': {
        const many = s.items.length > 5 && d.animate;
        const row = s.items.map((x) => <span key={x.id} className="shrink-0 text-[17px] font-semibold tracking-[-0.02em] whitespace-nowrap opacity-55 transition-opacity hover:opacity-100 @3xl:text-[19px]">{x.title}</span>);
        return (
          <div className={s.align === 'center' ? 'text-center' : ''}>
            {(s.eyebrow || s.title) && <div className="mb-7 text-[13px] text-muted">{s.eyebrow || s.title}</div>}
            {many ? (
              <div className="overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_12%,black_88%,transparent)]">
                <div className="home-marquee gap-14 pr-14">{row}{s.items.map((x) => <span key={`${x.id}-2`} aria-hidden className="shrink-0 text-[17px] font-semibold tracking-[-0.02em] whitespace-nowrap opacity-55 @3xl:text-[19px]">{x.title}</span>)}</div>
              </div>
            ) : <div className={cn('flex flex-wrap items-center gap-x-12 gap-y-5', s.align === 'center' && 'justify-center')}>{row}</div>}
          </div>
        );
      }
      case 'stats':
        return (
          <>
            {heading({ s: s, inverted: accentBg || s.background === 'inverted' })}
            <div className={cn('grid grid-cols-2 gap-x-6 gap-y-10', { 1: '', 2: '@3xl:grid-cols-2', 3: '@3xl:grid-cols-3', 4: '@3xl:grid-cols-4' }[s.columns])}>
              {s.items.map((x) => (
                <div key={x.id} className={cn('home-reveal', s.align === 'center' && 'text-center')}>
                  <div className="text-[38px] leading-none font-semibold tracking-[-0.045em] @3xl:text-[50px]" style={accentBg ? undefined : { color: 'var(--fa)' }}>{x.value}</div>
                  <div className={cn('mt-2.5 text-[14px]', accentBg ? 'opacity-80' : 'text-muted')}>{x.title}</div>
                  {x.text && <div className={cn('mt-1 text-[12.5px]', accentBg ? 'opacity-60' : 'text-subtle')}>{x.text}</div>}
                </div>
              ))}
            </div>
          </>
        );
      case 'features':
        return (
          <>
            {heading({ s: s, inverted: accentBg || s.background === 'inverted' })}
            <div className={cn('grid gap-4', cols)}>
              {s.items.map((x) => {
                const I = SECTION_ICON_MAP[x.icon] ?? Sparkles;
                return (
                  <div key={x.id} className="home-reveal group relative overflow-hidden border border-border bg-surface p-6 transition-all duration-300 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[var(--raised-shadow)] @3xl:p-7" style={{ borderRadius: 'calc(var(--fr) + 6px)' }}>
                    <div className="pointer-events-none absolute -top-16 -right-16 size-40 rounded-full opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100" style={{ background: tint(25) }} aria-hidden />
                    <span className="relative mb-5 grid size-11 place-items-center" style={{ background: tint(14), color: 'var(--fa)', borderRadius: 'calc(var(--fr) + 2px)' }}><I className="size-5" /></span>
                    <h3 className="relative text-[16.5px] font-semibold tracking-[-0.02em] text-fg">{x.title}</h3>
                    {x.text && <p className="relative mt-2 text-[14px] leading-relaxed text-muted">{x.text}</p>}
                  </div>
                );
              })}
            </div>
          </>
        );
      case 'steps':
        return (
          <>
            {heading({ s: s, inverted: accentBg || s.background === 'inverted' })}
            <ol className={cn('relative grid gap-10 @3xl:gap-6', { 1: '', 2: '@3xl:grid-cols-2', 3: '@3xl:grid-cols-3', 4: '@3xl:grid-cols-4' }[Math.min(4, Math.max(1, s.items.length)) as 1])}>
              {s.items.length > 1 && <div className="absolute top-6 right-[12%] left-[12%] hidden h-px @3xl:block" style={{ background: `linear-gradient(90deg, transparent, ${tint(45)}, transparent)` }} aria-hidden />}
              {s.items.map((x, i) => (
                <li key={x.id} className={cn('home-reveal relative', s.align === 'center' && 'text-center')}>
                  <span className={cn('relative grid size-12 place-items-center rounded-full border-4 border-bg text-[16px] font-semibold', s.align === 'center' && 'mx-auto')} style={{ background: 'var(--fa)', color: 'var(--fa-fg)', boxShadow: `0 0 0 6px ${tint(14)}` }}>{i + 1}</span>
                  <h3 className="mt-5 text-[17px] font-semibold tracking-[-0.02em]">{x.title}</h3>
                  {x.text && <p className={cn('mt-2 text-[14px] leading-relaxed', accentBg ? 'opacity-80' : 'text-muted', s.align === 'center' && 'mx-auto max-w-xs')}>{x.text}</p>}
                </li>
              ))}
            </ol>
          </>
        );
      case 'testimonials':
        return (
          <>
            {heading({ s: s, inverted: accentBg || s.background === 'inverted' })}
            <div className={cn('grid gap-4', s.items.length === 1 ? 'mx-auto max-w-3xl' : cols)}>
              {s.items.map((x) => (
                <figure key={x.id} className={cn('home-reveal flex flex-col border border-border bg-surface p-7', s.items.length === 1 && 'items-center p-10 text-center')} style={{ borderRadius: 'calc(var(--fr) + 6px)' }}>
                  <div className="mb-4 flex gap-0.5" style={{ color: 'var(--fa)' }}>{[0, 1, 2, 3, 4].map((i) => <Star key={i} className="size-4 fill-current" />)}</div>
                  <blockquote className={cn('flex-1 leading-relaxed text-fg', s.items.length === 1 ? 'text-[20px] font-medium tracking-[-0.015em] @3xl:text-[24px]' : 'text-[15px]')}><Quote className="mb-2 inline size-4 opacity-30" /> {x.text}</blockquote>
                  <figcaption className="mt-6 flex items-center gap-3">
                    <span className="grid size-10 place-items-center rounded-full text-[13px] font-semibold" style={{ background: tint(16), color: 'var(--fa)' }}>{x.author.split(' ').map((p) => p[0]).slice(0, 2).join('') || '★'}</span>
                    <span className="text-left"><span className="block text-[14px] font-semibold">{x.author}</span>{x.role && <span className="block text-[12.5px] text-muted">{x.role}</span>}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </>
        );
      case 'faq': {
        const list = (
          <div className="home-faq divide-y divide-border border-y border-border">
            {s.items.map((x) => (
              <details key={x.id} className="group py-1">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-4 text-[15.5px] font-medium tracking-[-0.01em]">
                  {x.title}<span className="home-faq-icon grid size-7 shrink-0 place-items-center rounded-full border border-border-strong transition-transform duration-300"><Plus className="size-3.5" /></span>
                </summary>
                <p className="pr-12 pb-5 text-[14.5px] leading-relaxed text-muted">{x.text}</p>
              </details>
            ))}
          </div>
        );
        return s.align === 'left'
          ? <div className="grid grid-cols-1 gap-10 @4xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] @4xl:gap-16"><div className="[&>div]:mb-0">{heading({ s })}</div>{list}</div>
          : <div className="mx-auto max-w-3xl">{heading({ s })}{list}</div>;
      }
      case 'cta':
        return (
          <div className={cn('relative', s.align === 'center' ? 'mx-auto max-w-3xl text-center' : 'flex flex-col gap-8 @4xl:flex-row @4xl:items-center @4xl:justify-between')}>
            <div className={s.align === 'center' ? '' : 'max-w-2xl'}>
              {s.eyebrow && <div className="mb-3 text-[12.5px] font-semibold tracking-[0.08em] uppercase opacity-75">{s.eyebrow}</div>}
              <h2 className="text-[30px] leading-[1.08] font-semibold tracking-[-0.035em] text-balance @3xl:text-[44px]"><Rich text={s.title} /></h2>
              {s.subtitle && <p className="mt-4 text-[16px] leading-relaxed opacity-75 @3xl:text-[18px]">{s.subtitle}</p>}
            </div>
            {(s.primary || s.secondary) && <div className={cn('flex shrink-0 flex-wrap gap-3', s.align === 'center' && 'mt-8 justify-center')}>{s.primary && btn({ l: s.primary })}{s.secondary && btn({ l: s.secondary, kind: 'secondary', onDark: accentBg || s.background === 'inverted' })}</div>}
          </div>
        );
      case 'form':
        return s.id === owner ? (
          <div className="mx-auto max-w-[640px]">{heading({ s: { ...s, align: 'center' } })}{FormBlock}</div>
        ) : (
          <div className="text-center">{heading({ s: { ...s, align: 'center' } })}{btn({ l: { label: 'Apply now', action: 'form', href: '' } })}</div>
        );
      case 'content':
        return (
          <div className={cn('max-w-3xl', s.align === 'center' && 'mx-auto text-center')}>
            {heading({ s: { ...s, align: s.align } })}
            <div className="-mt-6 flex flex-col gap-4 text-[15.5px] leading-[1.75] text-fg-2">{s.body.split(/\n\s*\n/).filter(Boolean).map((p, i) => <p key={i} className="whitespace-pre-line">{p}</p>)}</div>
          </div>
        );
    }
  };

  const pad = { compact: 'py-12 @3xl:py-14', normal: 'py-16 @3xl:py-24', spacious: 'py-20 @3xl:py-32' };

  return (
    <div id="top" data-theme={theme} className={cn('@container relative w-full overflow-x-clip bg-bg text-fg antialiased', className)} style={vars}
      onClickCapture={preview ? (e) => { const a = (e.target as HTMLElement).closest('a'); if (a && !(a.getAttribute('href') ?? '').startsWith('#')) e.preventDefault(); } : undefined}>
      {homepage.nav.show && (
        <header className={cn('z-40 w-full border-b border-border/70 bg-bg/75 backdrop-blur-xl backdrop-saturate-150', homepage.nav.sticky && 'sticky top-0')}>
          <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-5 @3xl:px-8">
            {Brandmark}
            <nav className="hidden items-center gap-1 @3xl:flex">{homepage.nav.links.map((l, i) => <a key={i} href={l.href} className="rounded-md px-3 py-1.5 text-[14px] text-muted transition-colors hover:bg-surface-3 hover:text-fg">{l.label}</a>)}</nav>
            <div className="ml-auto hidden items-center gap-2 @3xl:flex">
              {viewer ? <a href={viewer.dashboardHref} className="px-3 text-[14px] font-medium text-fg-2 hover:text-fg">Open dashboard</a> : homepage.nav.showSignIn && <a href="/login" className="px-3 text-[14px] font-medium text-fg-2 hover:text-fg">{homepage.nav.signInLabel}</a>}
              {homepage.nav.cta && btn({ l: homepage.nav.cta, size: 'md' })}
            </div>
            <button type="button" onClick={() => setMenu(!menu)} aria-label="Menu" aria-expanded={menu} className="ml-auto grid size-10 place-items-center rounded-lg border border-border @3xl:hidden">{menu ? <X className="size-4" /> : <Menu className="size-4" />}</button>
          </div>
          {menu && (
            <div className="animate-fade-in border-t border-border px-5 pt-3 pb-5 @3xl:hidden">
              <nav className="flex flex-col">{homepage.nav.links.map((l, i) => <a key={i} href={l.href} onClick={() => setMenu(false)} className="border-b border-border py-3 text-[15px]">{l.label}</a>)}</nav>
              <div className="mt-4 flex flex-col gap-2">
                {viewer ? <a href={viewer.dashboardHref} className="py-2 text-center text-[15px] font-medium">Open dashboard</a> : homepage.nav.showSignIn && <a href="/login" className="py-2 text-center text-[15px] font-medium">{homepage.nav.signInLabel}</a>}
                {homepage.nav.cta && <div className="[&>a]:w-full" onClick={() => setMenu(false)}>{btn({ l: homepage.nav.cta })}</div>}
              </div>
            </div>
          )}
        </header>
      )}

      <main>
        {sections.map((s) => {
          const inverted = s.background === 'inverted';
          const accent = s.background === 'accent';
          const node = (
            <section key={s.id} id={s.anchor || s.id} data-theme={inverted ? inverse : undefined}
              className={cn('relative scroll-mt-16 overflow-hidden', pad[s.spacing], s.hideOnMobile && 'hidden @3xl:block', (inverted || s.background === 'default' || s.background === 'glow' || s.background === 'grid') && 'bg-bg text-fg', s.background === 'muted' && 'bg-surface-2 text-fg')}
              style={accent ? { background: 'var(--fa)', color: 'var(--fa-fg)' } : undefined}>
              {s.background === 'glow' && <div className="pointer-events-none absolute inset-x-0 top-0 h-[640px]" style={{ background: `radial-gradient(60% 55% at 50% 0%, ${tint(24)}, transparent 75%)` }} aria-hidden />}
              {s.background === 'grid' && <div className="grid-backdrop pointer-events-none absolute inset-0 opacity-80" aria-hidden />}
              {inverted && <div className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(50% 80% at 50% 120%, ${tint(30)}, transparent 70%)` }} aria-hidden />}
              <div className={cn('relative mx-auto max-w-6xl px-5 @3xl:px-8', d.animate && s.type !== 'hero' && 'home-reveal')}>{body(s)}</div>
            </section>
          );
          return frame ? <Fragment key={s.id}>{frame(s, node)}</Fragment> : node;
        })}
        {!sections.length && <div className="py-40 text-center text-[14px] text-subtle">Add a section to start building your homepage.</div>}
      </main>

      <footer className="border-t border-border bg-bg">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 @3xl:flex-row @3xl:items-center @3xl:justify-between @3xl:px-8">
          <div className="flex flex-col gap-3">{Brandmark}{homepage.footer.text && <p className="max-w-md text-[13px] text-muted">{homepage.footer.text}</p>}</div>
          <div className="flex flex-col gap-3 @3xl:items-end">
            {homepage.footer.links.length > 0 && <nav className="flex flex-wrap gap-x-6 gap-y-2">{homepage.footer.links.map((l, i) => <a key={i} href={l.href} className="text-[13.5px] text-muted hover:text-fg">{l.label}</a>)}</nav>}
            {homepage.footer.showPoweredBy && <span className="text-[12px] text-subtle">Powered by {brand.productName}</span>}
          </div>
        </div>
      </footer>
    </div>
  );
}
