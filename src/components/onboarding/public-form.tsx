'use client';
import { logoText } from '@/components/shell/brand';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Loader2, Lock, Quote, Search, Sparkles, Star, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { COUNTRIES } from '@/lib/countries';
import {
  companyFromDomain, emailDomain, isFreeEmail, isVisible, LAYOUT_TYPES, validateAnswers,
  type Answers, type FormConfig, type FormField,
} from '@/lib/onboarding';

export type Brand = { productName: string; shortName: string; logoUrl: string | null; logoDarkUrl: string | null };
export type PublicFormData = { slug: string; name: string; closed: string | null; config: Omit<FormConfig, 'settings'> & { settings: Partial<FormConfig['settings']> & { leadFinder: FormConfig['settings']['leadFinder'] } }; assets: { logo: string | null; cover: string | null } };

const FONTS: Record<string, string> = {
  geist: 'var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif',
  inter: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  mono: 'var(--font-geist-mono), ui-monospace, monospace',
};

/** Readable text colour (black/white) on top of an accent colour. */
function onAccent(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#0b0b0b' : '#ffffff';
}


export function PublicFormView({ form, brand, preview = false, onPreviewSubmit, className = 'min-h-screen', initialStep = 0, embedded = false, presetInterests = null, onDone, monochrome = false }: { form: PublicFormData; brand: Brand; preview?: boolean; onPreviewSubmit?: () => void; className?: string; initialStep?: number; /** Card only, for placing inside a landing page (no page chrome, no headline). */ embedded?: boolean;
  /** Lead interests captured elsewhere (homepage Lead Finder): sent with the application, and the in-form finder is skipped. */ presetInterests?: { criteria: unknown; summary?: string; matches?: number } | null;
  /** Called after a successful submission; the parent then renders its own confirmation. */ onDone?: (r: { activated: boolean; email: string; name: string }) => void;
  /** Black & white like the dashboards: the accent follows the active theme. */ monochrome?: boolean }) {
  const { config, assets } = form;
  const d = config.design;
  const c = config.content;
  const st = config.settings;
  const storeKey = `lcrm.join.${form.slug}`;
  const [answers, setAnswers] = useState<Answers>(() => Object.fromEntries(config.fields.filter((f) => f.defaultValue).map((f) => [f.key, f.defaultValue!])));
  const [step, setStep] = useState(Math.min(initialStep, config.steps.length - 1));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | { activated: boolean }>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [interests, setInterests] = useState<{ criteria: unknown; summary?: string; matches?: number } | null>(presetInterests);
  const [hp, setHp] = useState('');
  const startedAt = useRef(Date.now());
  const [restored, setRestored] = useState(false);

  // Resume where the applicant left off (never in the admin preview).
  useEffect(() => {
    if (preview) return;
    try {
      const raw = localStorage.getItem(storeKey);
      if (raw) { const s = JSON.parse(raw) as { answers: Answers; step: number }; setAnswers((a) => ({ ...a, ...s.answers })); setStep(Math.min(s.step, config.steps.length - 1)); setRestored(true); }
    } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (preview || done) return;
    const t = setTimeout(() => { try { localStorage.setItem(storeKey, JSON.stringify({ answers, step })); } catch {} }, 400);
    return () => clearTimeout(t);
  }, [answers, step, preview, done, storeKey]);
  useEffect(() => { if (step >= config.steps.length) setStep(Math.max(0, config.steps.length - 1)); }, [config.steps.length, step]);

  const set = (key: string, v: Answers[string]) => { setAnswers((a) => ({ ...a, [key]: v })); setErrors((e) => { const n = { ...e }; delete n[key]; return n; }); };
  const lastStep = config.steps.length - 1;
  const finderStep = st.leadFinder?.enabled && !presetInterests ? lastStep : -1;
  const visible = config.fields.filter((f) => f.step === step && isVisible(f, answers));
  const progress = config.steps.length > 1 ? (step + (done ? 1 : 0)) / config.steps.length : done ? 1 : 0;
  const answerable = config.fields.filter((f) => !LAYOUT_TYPES.includes(f.type)).length;
  const minutes = Math.max(1, Math.round(answerable * 0.15 + (finderStep >= 0 ? 1 : 0)));

  // Smart suggestions from the email domain.
  const email = String(answers.email ?? '');
  const domain = email.includes('@') ? emailDomain(email) : '';
  const corporate = domain && !isFreeEmail(email) && domain.includes('.');
  const suggestWebsite = corporate && !answers.website && config.fields.some((f) => f.key === 'website' && isVisible(f, answers)) ? `https://${domain}` : null;
  const suggestName = corporate && !answers.businessName ? companyFromDomain(domain) : null;

  const next = () => {
    const { errors: e } = validateAnswers(config, answers, step);
    if (step === finderStep && st.leadFinder.required && !interests) e._leadFinder = 'Tell us what leads you are looking for';
    setErrors(e);
    if (Object.keys(e).length) return;
    if (step < lastStep) setStep(step + 1);
    else void submit();
  };

  const submit = async () => {
    if (preview) { onPreviewSubmit?.(); if (onDone) onDone({ activated: false, email: String(answers.email ?? ''), name: String(answers.contactName ?? '') }); else setDone({ activated: false }); return; }
    setBusy(true);
    setFatal(null);
    try {
      const res = await fetch(`/api/v1/public/forms/${form.slug}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers, startedAt: startedAt.current, leadInterests: interests, hp: hp || undefined, ref: referralCode() }) });
      const j = await res.json();
      if (!res.ok) {
        const fields = (j.error?.details?.fields ?? {}) as Record<string, string>;
        if (Object.keys(fields).length) {
          setErrors(fields);
          const first = config.fields.find((f) => fields[f.key]);
          if (first) setStep(first.step);
        } else setFatal(j.error?.message ?? 'Something went wrong. Please try again.');
        return;
      }
      try { localStorage.removeItem(storeKey); } catch {}
      if (onDone) onDone({ activated: Boolean(j.activated), email: String(answers.email ?? ''), name: String(answers.contactName ?? '') });
      else setDone({ activated: Boolean(j.activated) });
    } catch {
      setFatal('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const accentFg = onAccent(d.accent);
  const theme = d.theme === 'auto' ? undefined : d.theme;
  const r = `${d.radius}px`;
  const gap = d.density === 'compact' ? 'gap-3' : 'gap-4';
  const maxW = { narrow: 'max-w-[440px]', normal: 'max-w-[560px]', wide: 'max-w-[720px]' }[d.width];
  const split = d.layout === 'split-left' || d.layout === 'split-right';
  const logo = assets.logo ?? brand.logoUrl;

  const bg = d.background === 'gradient' ? { background: `linear-gradient(135deg, ${d.gradientFrom}, ${d.gradientTo})` }
    : d.background === 'image' && assets.cover ? { backgroundImage: `linear-gradient(rgba(0,0,0,.35), rgba(0,0,0,.35)), url(${assets.cover})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : {};

  const Brandmark = (
    d.showLogo ? (
      <div className="flex items-center gap-2.5">
        {logo
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={logo} alt={brand.productName} className="h-7 w-auto max-w-[160px] object-contain" />
          : <span className="grid size-7 place-items-center rounded-md text-[11px] font-bold" style={{ background: 'var(--fa)', color: 'var(--fa-fg)' }}>{brand.shortName}</span>}
        {!assets.logo && !brand.logoUrl && <span className="text-[14px] font-semibold tracking-[-0.02em]">{logoText(brand.productName)}</span>}
      </div>
    ) : null
  );

  const Side = (
    <aside className={cn('relative hidden flex-col justify-between overflow-hidden p-10 @4xl:flex', d.layout === 'split-right' && 'order-2')} style={assets.cover && d.background !== 'image' ? { backgroundImage: `linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.65)), url(${assets.cover})`, backgroundSize: 'cover', backgroundPosition: 'center', color: '#fff' } : { background: 'var(--fa)', color: 'var(--fa-fg)' }}>
      <div>{Brandmark}</div>
      <div className="my-10">
        {c.sideTitle && <h2 className="text-[30px] leading-[1.15] font-semibold tracking-[-0.03em]" style={{ color: 'inherit' }}>{c.sideTitle}</h2>}
        {c.sideText && <p className="mt-3 max-w-md text-[14px] leading-relaxed opacity-80">{c.sideText}</p>}
        {c.benefits.length > 0 && (
          <ul className="mt-7 flex flex-col gap-3">
            {c.benefits.map((b) => <li key={b} className="flex items-start gap-2.5 text-[13.5px]"><span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-white/15"><Check className="size-3" /></span><span className="opacity-90">{b}</span></li>)}
          </ul>
        )}
        {c.stats.length > 0 && (
          <div className="mt-8 flex gap-8">{c.stats.map((s) => <div key={s.label}><div className="text-[26px] font-semibold tracking-[-0.03em]">{s.value}</div><div className="text-[12px] opacity-70">{s.label}</div></div>)}</div>
        )}
      </div>
      {c.testimonial?.quote ? (
        <figure className="rounded-xl bg-white/10 p-5 backdrop-blur-sm">
          <Quote className="mb-2 size-4 opacity-60" />
          <blockquote className="text-[13.5px] leading-relaxed">{c.testimonial.quote}</blockquote>
          <figcaption className="mt-3 text-[12px] opacity-75">{c.testimonial.author}{c.testimonial.role && ` · ${c.testimonial.role}`}</figcaption>
        </figure>
      ) : <div className="text-[11.5px] opacity-60">{c.footer}</div>}
    </aside>
  );

  const CardEl = (
          <div
            className={cn('w-full', d.layout === 'minimal' && !embedded ? '' : 'border border-border bg-surface shadow-[var(--raised-shadow)]', d.density === 'compact' ? 'p-5' : 'p-6 @xl:p-8', d.animate && 'animate-fade-in')}
            style={{ borderRadius: d.layout === 'minimal' && !embedded ? 0 : `calc(var(--fr) + 6px)` }}
          >
            {form.closed ? (
              <div className="py-10 text-center"><Lock className="mx-auto mb-3 size-6 text-subtle" /><div className="text-[16px] font-semibold">{form.closed}</div></div>
            ) : done ? (
              <div className={cn('py-8 text-center', d.animate && 'animate-pop')}>
                <span className="mx-auto mb-4 grid size-14 place-items-center rounded-full" style={{ background: 'var(--fa)', color: 'var(--fa-fg)' }}><CheckCircle2 className="size-7" /></span>
                <h2 className="text-[22px] font-semibold tracking-[-0.025em]">{done.activated ? 'Your workspace is ready' : c.successTitle}</h2>
                <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-muted">{done.activated ? `We’ve emailed ${email || 'you'} a link to set your password and open your dashboard.` : c.successMessage}</p>
                {preview && <button type="button" onClick={() => { setDone(null); setStep(0); }} className="mt-5 text-[12px] text-subtle underline">Reset preview</button>}
              </div>
            ) : (
              <>
                {!embedded && c.badge && <span className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-border-strong px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-muted"><Sparkles className="size-3" style={{ color: 'var(--fa)' }} />{c.badge}</span>}
                {!embedded && <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.03em] @xl:text-[27px]">{c.title}</h1>}
                {!embedded && c.subtitle && <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{c.subtitle}</p>}
                <div className={cn('text-[11.5px] text-subtle', !embedded && 'mt-2')}>Takes about {minutes} minute{minutes === 1 ? '' : 's'}{restored ? ' · we restored your progress' : ''}</div>

                {config.steps.length > 1 && d.progress !== 'none' && (
                  d.progress === 'bar' ? (
                    <div className="mt-5"><div className="mb-1.5 flex justify-between text-[11.5px] text-subtle"><span>{config.steps[step]?.title}</span><span>Step {step + 1} of {config.steps.length}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(6, progress * 100 + 100 / config.steps.length / 2)}%`, background: 'var(--fa)' }} /></div></div>
                  ) : (
                    <ol className="mt-5 flex items-center gap-2">
                      {config.steps.map((s, i) => (
                        <li key={s.id} className="flex min-w-0 flex-1 items-center gap-2">
                          <span className={cn('grid size-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold transition-colors')} style={i <= step ? { background: 'var(--fa)', color: 'var(--fa-fg)', borderColor: 'var(--fa)' } : undefined}>{i < step ? <Check className="size-3.5" /> : i + 1}</span>
                          <span className={cn('truncate text-[12px]', i === step ? 'font-medium text-fg' : 'text-subtle')}>{s.title}</span>
                          {i < config.steps.length - 1 && <span className="h-px min-w-3 flex-1 bg-border-strong" />}
                        </li>
                      ))}
                    </ol>
                  )
                )}
                {config.steps[step]?.description && <p className="mt-4 text-[12.5px] text-muted">{config.steps[step].description}</p>}

                <form key={step} className={cn('mt-5 grid grid-cols-2', gap, d.animate && 'animate-fade-in')} onSubmit={(e) => { e.preventDefault(); next(); }} noValidate>
                  <input type="text" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} className="hidden" aria-hidden name="company_website" />
                  {visible.map((f) => (
                    <FieldView key={f.id} f={f} value={answers[f.key]} error={errors[f.key]} onChange={(v) => set(f.key, v)} inputStyle={d.inputStyle}
                      hint={f.key === 'website' && suggestWebsite ? { label: `Use ${suggestWebsite}`, apply: () => set('website', suggestWebsite) } : f.key === 'businessName' && suggestName ? { label: `Use “${suggestName}”`, apply: () => set('businessName', suggestName) } : f.key === 'email' && st.requireBusinessEmail && email.includes('@') && isFreeEmail(email) ? { label: 'Please use your work email address', apply: null } : null} />
                  ))}
                  {step === finderStep && <div className="col-span-2"><FormLeadFinder slug={form.slug} title={st.leadFinder.title} description={st.leadFinder.description} preview={preview} onChange={setInterests} error={errors._leadFinder} /></div>}
                  {fatal && <div className="col-span-2 rounded-md border border-danger/30 bg-danger-dim px-3 py-2 text-[12.5px] text-danger">{fatal}</div>}
                  <div className="col-span-2 mt-2 flex items-center gap-3">
                    {step > 0 && <button type="button" onClick={() => setStep(step - 1)} className="flex items-center gap-1.5 px-1 text-[13px] text-muted hover:text-fg"><ArrowLeft className="size-4" />{c.backLabel}</button>}
                    <button type="submit" disabled={busy}
                      className={cn('ml-auto flex h-11 items-center justify-center gap-2 px-6 text-[14px] font-medium transition-all hover:opacity-90 disabled:opacity-60', d.buttonStyle === 'pill' ? 'rounded-full' : '', step === lastStep && 'min-w-[180px]')}
                      style={d.buttonStyle === 'outline' ? { border: '1.5px solid var(--fa)', color: 'var(--fa)', borderRadius: 'var(--fr)' } : { background: 'var(--fa)', color: 'var(--fa-fg)', borderRadius: d.buttonStyle === 'pill' ? 999 : 'var(--fr)' }}>
                      {busy ? <Loader2 className="size-4 animate-spin" /> : null}{step === lastStep ? c.submitLabel : c.nextLabel}{!busy && step < lastStep && <ArrowRight className="size-4" />}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
  );
  const FooterEl = (
          <footer className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-center text-[11.5px] text-subtle">
            {c.footer && !split && <span>{c.footer}</span>}
            {c.termsUrl && <a href={c.termsUrl} target="_blank" rel="noreferrer noopener" className="underline-offset-2 hover:underline">Terms</a>}
            {c.privacyUrl && <a href={c.privacyUrl} target="_blank" rel="noreferrer noopener" className="underline-offset-2 hover:underline">Privacy</a>}
            <span className="flex items-center gap-1"><Lock className="size-3" />Secured by {brand.productName}</span>
          </footer>
  );
  const vars = { fontFamily: monochrome ? FONTS.geist : FONTS[d.font], ...({ '--fa': monochrome ? 'var(--fg)' : d.accent, '--fa-fg': monochrome ? 'var(--inverse)' : accentFg, '--fr': monochrome ? '8px' : r } as React.CSSProperties) };
  if (embedded) return <div className={cn('@container w-full text-left text-fg', className)} style={vars}>{CardEl}{FooterEl}</div>;

  return (
    <div data-theme={theme} className={cn('@container w-full', className)} style={{ fontFamily: FONTS[d.font], ...({ '--fa': d.accent, '--fa-fg': accentFg, '--fr': r } as React.CSSProperties) }}>
    <div className={cn('relative min-h-[inherit] w-full bg-bg text-fg', split && '@4xl:grid @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]')} style={!split ? bg : undefined}>
      {!split && d.background === 'grid' && <div className="grid-backdrop pointer-events-none absolute inset-0" aria-hidden />}
      {!split && d.background === 'dots' && <div className="dot-canvas pointer-events-none absolute inset-0 opacity-70" aria-hidden />}
      {split && Side}
      <main className={cn('relative flex min-h-full flex-col px-5 py-8 @xl:px-8', split ? 'justify-center' : 'items-center justify-center')} style={split ? bg : undefined}>
        {split && d.background === 'grid' && <div className="grid-backdrop pointer-events-none absolute inset-0" aria-hidden />}
        <div className={cn('relative w-full', maxW, split && 'mx-auto')}>
          <div className={cn('mb-6', split && '@4xl:hidden')}>{Brandmark}</div>
          {CardEl}
          {FooterEl}
        </div>
      </main>
    </div>
    </div>
  );
}

function FieldView({ f, value, error, onChange, inputStyle, hint }: { f: FormField; value: Answers[string]; error?: string; onChange: (v: Answers[string]) => void; inputStyle: string; hint: { label: string; apply: (() => void) | null } | null }) {
  const span = f.width === 'half' && !['heading', 'paragraph', 'divider', 'consent', 'textarea', 'multiselect'].includes(f.type) ? 'col-span-2 @xl:col-span-1' : 'col-span-2';
  const base = cn('w-full text-[14px] text-fg outline-none transition-colors placeholder:text-subtle',
    inputStyle === 'underline' ? 'border-0 border-b border-border-strong bg-transparent px-0 py-2 focus:border-[color:var(--fa)]'
      : inputStyle === 'filled' ? 'border border-transparent bg-surface-3 px-3.5 py-2.5 focus:border-[color:var(--fa)] focus:bg-surface'
        : 'border border-border-strong bg-surface px-3.5 py-2.5 focus:border-[color:var(--fa)] focus:ring-2 focus:ring-[color:var(--fa)]/15',
    error && 'border-danger');
  const radius = inputStyle === 'underline' ? undefined : { borderRadius: 'var(--fr)' };
  const s = value == null ? '' : String(value);
  const id = `fld-${f.id}`;
  if (f.type === 'heading') return <h3 className="col-span-2 mt-2 text-[16px] font-semibold tracking-[-0.02em]">{f.label}</h3>;
  if (f.type === 'paragraph') return <p className="col-span-2 text-[13px] leading-relaxed text-muted">{f.label}</p>;
  if (f.type === 'divider') return <hr className="col-span-2 border-border" />;
  const label = <label htmlFor={id} className="mb-1.5 block text-[12.5px] font-medium text-fg-2">{f.label}{f.required && <span className="ml-0.5" style={{ color: 'var(--fa)' }}>*</span>}</label>;
  const foot = (
    <>
      {hint && (hint.apply ? <button type="button" onClick={hint.apply} className="mt-1.5 flex items-center gap-1 text-[11.5px] font-medium" style={{ color: 'var(--fa)' }}><Wand2 className="size-3" />{hint.label}</button> : <div className="mt-1.5 text-[11.5px] text-warn">{hint.label}</div>)}
      {error ? <div className="mt-1.5 text-[11.5px] text-danger">{error}</div> : f.help ? <div className="mt-1.5 text-[11.5px] text-subtle">{f.help}</div> : null}
    </>
  );
  if (f.type === 'consent' || f.type === 'checkbox') {
    return (
      <div className="col-span-2">
        <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-muted">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0" style={{ accentColor: 'var(--fa)' }} />
          <span>{f.label}{f.required && <span className="ml-0.5" style={{ color: 'var(--fa)' }}>*</span>}</span>
        </label>
        {foot}
      </div>
    );
  }
  if (f.type === 'radio' || f.type === 'multiselect') {
    const multi = f.type === 'multiselect';
    const arr = Array.isArray(value) ? value : [];
    return (
      <div className={span}>
        {label}
        <div className="flex flex-wrap gap-2">
          {(f.options ?? []).map((o) => {
            const on = multi ? arr.includes(o) : s === o;
            return (
              <button key={o} type="button" onClick={() => onChange(multi ? (on ? arr.filter((x) => x !== o) : [...arr, o]) : o)} aria-pressed={on}
                className={cn('border px-3 py-2 text-[13px] transition-all', on ? 'font-medium' : 'border-border-strong text-muted hover:text-fg')}
                style={{ borderRadius: 'var(--fr)', ...(on ? { borderColor: 'var(--fa)', background: 'color-mix(in srgb, var(--fa) 10%, transparent)', color: 'var(--fg)' } : {}) }}>
                {o}
              </button>
            );
          })}
        </div>
        {foot}
      </div>
    );
  }
  if (f.type === 'rating') {
    const max = f.max ?? 5;
    return (
      <div className={span}>
        {label}
        <div className="flex gap-1">{Array.from({ length: max }, (_, i) => i + 1).map((n) => <button key={n} type="button" aria-label={`${n}`} onClick={() => onChange(n)}><Star className="size-6" style={{ color: Number(value) >= n ? 'var(--fa)' : 'var(--faint)', fill: Number(value) >= n ? 'var(--fa)' : 'transparent' }} /></button>)}</div>
        {foot}
      </div>
    );
  }
  return (
    <div className={span}>
      {label}
      {f.type === 'textarea' ? (
        <textarea id={id} rows={4} className={cn(base, 'resize-y')} style={radius} placeholder={f.placeholder} maxLength={f.maxLength} value={s} onChange={(e) => onChange(e.target.value)} />
      ) : f.type === 'select' || f.type === 'country' ? (
        <select id={id} className={cn(base, 'appearance-none')} style={radius} value={s} onChange={(e) => onChange(e.target.value)}>
          <option value="">{f.placeholder || 'Select…'}</option>
          {(f.type === 'country' ? COUNTRIES : f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input id={id} className={base} style={radius} placeholder={f.placeholder} maxLength={f.maxLength}
          type={f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'url' ? 'url' : 'text'}
          autoComplete={{ email: 'email', phone: 'tel', url: 'url' }[f.type as string] ?? (f.key === 'contactName' ? 'name' : f.key === 'businessName' ? 'organization' : 'off')}
          min={f.min} max={f.max} value={s} onChange={(e) => onChange(f.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)} />
      )}
      {foot}
    </div>
  );
}

type FinderResp = { reply: string; criteria: unknown; chips: string[]; quickReplies: { label: string; action?: unknown; message?: string }[]; summary: { total: number; industries: { label: string; count: number }[]; regions: { label: string; count: number }[] } | null };

/** Compact, public Lead Finder: aggregate counts only. Captures what the applicant is looking for. */
function FormLeadFinder({ slug, title, description, preview, onChange, error }: { slug: string; title: string; description: string; preview: boolean; onChange: (v: { criteria: unknown; summary?: string; matches?: number } | null) => void; error?: string }) {
  const [state, setState] = useState<FinderResp | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const call = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/public/forms/${slug}/finder`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ criteria: state?.criteria, history: [], ...body }) });
      if (!res.ok) { setState((s) => s ?? { reply: preview ? 'Publish the form (or save it) to try the Lead Finder here.' : 'The Lead Finder is unavailable right now.', criteria: undefined, chips: [], quickReplies: [], summary: null }); return; }
      const j = (await res.json()) as FinderResp;
      setState(j);
      if (j.chips.length) onChange({ criteria: j.criteria, summary: j.chips.join(', '), matches: j.summary?.total });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void call({ action: { type: 'start' } }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const max = Math.max(1, ...(state?.summary?.industries ?? []).map((x) => x.count), ...(state?.summary?.regions ?? []).map((x) => x.count));
  const plain = (s: string) => s.replace(/\*\*/g, '');
  return (
    <div className={cn('overflow-hidden border', error ? 'border-danger' : 'border-border-strong')} style={{ borderRadius: 'calc(var(--fr) + 4px)' }}>
      <div className="flex items-center gap-2.5 px-4 py-3" style={{ background: 'color-mix(in srgb, var(--fa) 8%, transparent)' }}>
        <span className="grid size-8 place-items-center rounded-lg" style={{ background: 'var(--fa)', color: 'var(--fa-fg)' }}><Sparkles className="size-4" /></span>
        <div><div className="text-[13.5px] font-semibold">{title}</div>{description && <div className="text-[11.5px] text-muted">{description}</div>}</div>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="text-[13px] leading-relaxed text-fg-2">{state ? plain(state.reply) : 'Loading…'}</div>
        {state && state.chips.length > 0 && <div className="flex flex-wrap gap-1.5">{state.chips.map((c) => <span key={c} className="rounded-full border border-border-strong px-2.5 py-0.5 text-[11.5px]">{c}</span>)}</div>}
        {state?.summary && state.summary.total > 0 && (state.summary.industries.length > 0 || state.summary.regions.length > 0) && (
          <div className="grid grid-cols-2 gap-3">
            {[state.summary.industries, state.summary.regions].map((list, i) => (
              <div key={i}>{list.slice(0, 3).map((x) => (
                <div key={x.label} className="mb-1.5">
                  <div className="flex justify-between text-[11px]"><span className="truncate text-muted">{x.label}</span><span className="tabular-nums">{x.count}</span></div>
                  <div className="h-1 rounded-full bg-surface-3"><div className="h-full rounded-full" style={{ width: `${(x.count / max) * 100}%`, background: 'var(--fa)' }} /></div>
                </div>
              ))}</div>
            ))}
          </div>
        )}
        {state && state.quickReplies.length > 0 && <div className="flex flex-wrap gap-1.5">{state.quickReplies.map((q, i) => <button key={i} type="button" disabled={busy} onClick={() => void call(q.message ? { message: q.message } : { action: q.action })} className="rounded-full border border-border-strong px-2.5 py-1 text-[12px] text-muted hover:text-fg">{q.label}</button>)}</div>}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-subtle" />
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (text.trim()) { void call({ message: text.trim() }); setText(''); } } }}
              placeholder="e.g. homeowners in Texas interested in solar" className="w-full border border-border-strong bg-surface py-2 pr-3 pl-9 text-[13px] outline-none focus:border-[color:var(--fa)]" style={{ borderRadius: 'var(--fr)' }} />
          </div>
          <button type="button" disabled={busy || !text.trim()} onClick={() => { void call({ message: text.trim() }); setText(''); }} className="px-4 text-[13px] font-medium disabled:opacity-50" style={{ background: 'var(--fa)', color: 'var(--fa-fg)', borderRadius: 'var(--fr)' }}>{busy ? <Loader2 className="size-4 animate-spin" /> : 'Search'}</button>
        </div>
        {error && <div className="text-[11.5px] text-danger">{error}</div>}
      </div>
    </div>
  );
}

/** Referral code from /join?ref=CODE (kept for the session so it survives navigation). */
function referralCode() {
  try {
    const q = new URLSearchParams(window.location.search).get('ref');
    if (q && /^[A-Za-z0-9]{4,20}$/.test(q)) { sessionStorage.setItem('lcrm:ref', q); return q.toUpperCase(); }
    const s = sessionStorage.getItem('lcrm:ref');
    return s ? s.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}
