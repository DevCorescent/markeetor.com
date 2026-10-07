'use client';
import { ExternalLink, Globe, ImageIcon, Monitor, Moon, Plus, Search, Sun, Trash2, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { BrandMark, logoText, type BrandInfo } from '@/components/shell/brand';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/overlay';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { setThemePref } from '@/lib/theme';

type Branding = { productName: string; shortName: string; tagline: string; showNameWithLogo: boolean; supportEmail: string };
type Seo = {
  siteUrl: string; defaultTitle: string; titleTemplate: string; description: string; keywords: string[]; allowIndexing: boolean;
  googleVerification: string; bingVerification: string; sitemapEnabled: boolean; sitemapPaths: string[]; twitterHandle: string;
};
type Appearance = { defaultTheme: 'light' | 'dark' | 'system'; allowUserChoice: boolean };
type Assets = { branding: { logoUrl: string | null; logoDarkUrl: string | null; faviconUrl: string; ogImageUrl: string | null }; limits: Record<string, { maxKb: number; types: string[] }> };

function useSaveSetting(key: string, after?: () => void) {
  const router = useRouter();
  return useApiMutation((value: unknown) => api('/api/v1/settings', { method: 'PUT', body: { key, value } }), {
    success: 'Saved — live for everyone',
    invalidate: ['/api/v1/settings', '/api/v1/branding'],
    onSuccess: () => { router.refresh(); after?.(); },
  });
}

/** Sticky save bar shown only while there are unsaved edits. */
function SaveBar({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  if (!dirty) return null;
  return (
    <div className="sticky bottom-4 z-20 mt-4 flex items-center justify-between gap-3 rounded-lg border border-border-strong bg-surface-2 px-4 py-2.5 shadow-[var(--raised-shadow)] animate-pop">
      <span className="text-[12.5px] text-muted">You have unsaved changes</span>
      <span className="flex gap-2"><Button variant="ghost" onClick={onReset}>Discard</Button><Button variant="primary" loading={saving} onClick={onSave}>Save changes</Button></span>
    </div>
  );
}

// ── Branding ─────────────────────────────────────────────────────────

export function BrandingSettings({ value }: { value: Branding }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const assets = useApiQuery<Assets>('/api/v1/branding');
  const save = useSaveSetting('branding');
  const dirty = JSON.stringify(v) !== JSON.stringify(value);
  const a = assets.data?.branding;
  const mark: BrandInfo = { ...v, logoUrl: a?.logoUrl ?? null, logoDarkUrl: a?.logoDarkUrl ?? null };

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardHeader title="Identity" description="How the product names itself across the app, sign-in screens, browser tabs and system emails." />
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Product name" hint="Shown in the sidebar, page titles and emails."><Input value={v.productName} maxLength={60} onChange={(e) => setV({ ...v, productName: e.target.value })} /></Field>
            <Field label="Tagline" hint="The small line under the name in the admin sidebar."><Input value={v.tagline} maxLength={80} onChange={(e) => setV({ ...v, tagline: e.target.value })} /></Field>
            <Field label="Monogram" hint="1–3 letters used when no logo is uploaded, and in the default favicon.">
              <div className="flex items-center gap-3">
                <Input value={v.shortName} maxLength={3} className="w-24 font-semibold uppercase tracking-wide" onChange={(e) => setV({ ...v, shortName: e.target.value.toUpperCase() })} />
                <BrandMark brand={{ ...mark, logoUrl: null, logoDarkUrl: null }} size={30} />
              </div>
            </Field>
            <Field label="Support email" hint="Optional. Shown to users when they need help."><Input type="email" value={v.supportEmail} placeholder="support@yourcompany.com" onChange={(e) => setV({ ...v, supportEmail: e.target.value })} /></Field>
            <label className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2.5 sm:col-span-2">
              <span><span className="block text-[12.5px] font-medium">Show the product name next to the logo</span><span className="block text-[11.5px] text-subtle">Turn off if your logo is a wordmark that already contains the name.</span></span>
              <Switch checked={v.showNameWithLogo} onCheckedChange={(c) => setV({ ...v, showNameWithLogo: c })} aria-label="Show name with logo" />
            </label>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Logo & icons" description="Files are checked by content (not file name). SVGs with scripts or external references are rejected." />
          <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {!assets.data ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-44" />) : (
              <>
                <AssetTile kind="logo" title="Logo" hint="Used in both themes. Transparent PNG or SVG, ~4:1 or square." url={a!.logoUrl} limits={assets.data.limits.logo} surface="auto" />
                <AssetTile kind="logoDark" title="Logo for dark theme" hint="Optional light-coloured version shown on dark backgrounds." url={a!.logoDarkUrl} limits={assets.data.limits.logoDark} surface="dark" />
                <AssetTile kind="favicon" title="Favicon" hint="Browser tab icon. Square PNG (512×512), ICO or SVG." url={a!.faviconUrl.includes('?v=') ? a!.faviconUrl : null} fallback={a!.faviconUrl} limits={assets.data.limits.favicon} surface="auto" square />
                <AssetTile kind="ogImage" title="Social share image" hint="Shown when links are shared. 1200×630 PNG or JPEG." url={a!.ogImageUrl} limits={assets.data.limits.ogImage} surface="auto" wide />
              </>
            )}
          </CardBody>
        </Card>
        <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate(v)} onReset={() => setV(value)} />
      </div>

      <div className="flex flex-col gap-4 xl:sticky xl:top-20 xl:self-start">
        <Card>
          <CardHeader title="Live preview" description="Updates as you type." />
          <CardBody className="flex flex-col gap-4">
            {(['light', 'dark'] as const).map((t) => (
              <div key={t}>
                <div className="eyebrow mb-1.5">{t === 'light' ? 'Light theme' : 'Dark theme'}</div>
                <div data-theme={t} className="overflow-hidden rounded-lg border border-border bg-bg text-fg">
                  <div className="flex h-12 items-center gap-2.5 border-b border-border px-3">
                    <BrandMark brand={mark} size={!mark.logoUrl || v.showNameWithLogo ? 22 : 24} />
                    {(!mark.logoUrl || v.showNameWithLogo) && (
                      <span className="min-w-0"><span className="block truncate text-[12.5px] font-semibold tracking-[-0.02em]">{logoText(v.productName) || 'Product name'}</span><span className="block truncate text-[10px] text-subtle">{v.tagline}</span></span>
                    )}
                  </div>
                  <div className="flex gap-2 p-3">
                    <div className="w-1/3 space-y-1.5">{[70, 55, 62, 48].map((w, i) => <div key={i} className={cn('h-1.5 rounded-full', i === 0 ? 'bg-fg' : 'bg-surface-3')} style={{ width: `${w}%` }} />)}</div>
                    <div className="flex-1 space-y-1.5"><div className="h-2.5 w-2/3 rounded bg-fg/90" /><div className="h-12 rounded border border-border bg-surface" /></div>
                  </div>
                </div>
              </div>
            ))}
            <div>
              <div className="eyebrow mb-1.5">Browser tab</div>
              <div className="flex items-center gap-2 rounded-t-lg border border-b-0 border-border bg-surface-3 px-3 py-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {a ? <img src={a.faviconUrl} alt="" className="size-4 rounded-[3px]" /> : <span className="size-4 rounded bg-surface" />}
                <span className="truncate text-[12px]">Command center · {v.productName || 'Product'}</span>
                <X className="ml-auto size-3 text-subtle" />
              </div>
              <div className="h-3 rounded-b-lg border border-border bg-surface" />
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function AssetTile({ kind, title, hint, url, fallback, limits, surface, square, wide }: {
  kind: string; title: string; hint: string; url: string | null; fallback?: string; limits: { maxKb: number; types: string[] }; surface: 'auto' | 'dark'; square?: boolean; wide?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const refresh = useApiQuery<Assets>('/api/v1/branding');
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api(`/api/v1/branding/${kind}`, { body: fd });
      toast.success(`${title} updated`);
      await refresh.refetch();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/api/v1/branding/${kind}`, { method: 'DELETE' });
      toast.success(`${title} removed`);
      await refresh.refetch();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const shown = url ?? fallback ?? null;
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void upload(f); }}
      className={cn('flex flex-col rounded-lg border p-3 transition-colors', over ? 'border-fg bg-surface-3' : 'border-border', wide && 'sm:col-span-2')}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div><div className="text-[12.5px] font-medium">{title}</div><div className="text-[11px] text-subtle">{hint}</div></div>
        {url ? <Badge tone="ok">Custom</Badge> : <Badge>Default</Badge>}
      </div>
      <div className={cn('relative grid place-items-center overflow-hidden rounded-md border border-border', surface === 'dark' ? 'bg-[#0b0b0b]' : 'bg-[repeating-conic-gradient(var(--surface-3)_0%_25%,var(--surface)_0%_50%)] [background-size:14px_14px]', wide ? 'aspect-[1200/630] max-h-56' : 'h-24')}>
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shown} alt={`${title} preview`} className={cn('max-h-full max-w-full object-contain', square ? 'size-12' : wide ? 'h-full w-full object-cover' : 'max-h-14 px-4')} />
        ) : (
          <span className="flex flex-col items-center gap-1 text-[11px] text-subtle"><ImageIcon className="size-5" />Drop an image here</span>
        )}
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="text-[10.5px] text-subtle">{limits.types.map((t) => t.toUpperCase()).join(' · ')} · max {limits.maxKb >= 1024 ? `${Math.round(limits.maxKb / 1024)} MB` : `${limits.maxKb} KB`}</span>
        <span className="flex gap-1">
          {url && <Button size="xs" variant="ghost" disabled={busy} onClick={remove} aria-label={`Remove ${title}`}><Trash2 /></Button>}
          <Button size="xs" loading={busy} onClick={() => input.current?.click()}><Upload /> {url ? 'Replace' : 'Upload'}</Button>
        </span>
      </div>
      <input ref={input} type="file" hidden accept={limits.types.map((t) => (t === 'svg' ? 'image/svg+xml' : t === 'ico' ? '.ico,image/x-icon' : `image/${t}`)).join(',')} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
    </div>
  );
}

// ── SEO & indexing ───────────────────────────────────────────────────

export function SeoSettings({ value, productName }: { value: Seo; productName: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const [robots, setRobots] = useState<string | null>(null);
  const loadRobots = () => fetch('/robots.txt', { cache: 'no-store' }).then((r) => r.text()).then(setRobots).catch(() => setRobots(null));
  useEffect(() => { void loadRobots(); }, []);
  const save = useSaveSetting('seo', () => void loadRobots());
  const dirty = JSON.stringify(v) !== JSON.stringify(value);
  const origin = (v.siteUrl || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/+$/, '');
  const title = v.defaultTitle || productName;
  const exampleTitle = v.titleTemplate.replaceAll('{product}', productName).replace('%s', 'Sign in');
  const assets = useApiQuery<Assets>('/api/v1/branding');

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardHeader title="Search appearance" description="Titles and descriptions used by search engines and link previews." />
          <CardBody className="grid gap-4">
            <Field label="Site URL" hint="The public address of this product, e.g. https://crm.yourcompany.com. Used for canonical links, the sitemap and social cards."><Input value={v.siteUrl} placeholder="https://crm.yourcompany.com" onChange={(e) => setV({ ...v, siteUrl: e.target.value })} /></Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Home page title" hint={`Defaults to “${productName}”.`}><Input value={v.defaultTitle} maxLength={120} placeholder={productName} onChange={(e) => setV({ ...v, defaultTitle: e.target.value })} /></Field>
              <Field label="Page title pattern" hint={`%s = page name, {product} = product name. Example: “${exampleTitle}”`}><Input value={v.titleTemplate} maxLength={120} onChange={(e) => setV({ ...v, titleTemplate: e.target.value })} /></Field>
            </div>
            <Field label="Meta description" hint={`${v.description.length}/160 recommended characters`}>
              <Textarea value={v.description} maxLength={320} rows={3} onChange={(e) => setV({ ...v, description: e.target.value })} className={cn(v.description.length > 160 && 'border-warn')} />
            </Field>
            <Field label="Keywords" hint="Press Enter to add. Most search engines ignore keywords; they are included for completeness.">
              <ChipInput values={v.keywords} onChange={(keywords) => setV({ ...v, keywords })} placeholder="lead management" max={30} />
            </Field>
            <Field label="X (Twitter) handle" hint="Optional, used on link cards."><Input value={v.twitterHandle} placeholder="@yourcompany" className="max-w-[240px]" onChange={(e) => setV({ ...v, twitterHandle: e.target.value })} /></Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Google indexing" description="Control whether search engines may list the public pages of this product." />
          <CardBody className="grid gap-4">
            <label className={cn('flex items-center justify-between gap-4 rounded-lg border px-4 py-3 transition-colors', v.allowIndexing ? 'border-ok/40 bg-ok-dim' : 'border-border')}>
              <span className="flex items-start gap-3">
                <Globe className={cn('mt-0.5 size-4', v.allowIndexing ? 'text-ok' : 'text-subtle')} />
                <span>
                  <span className="block text-[13px] font-medium">{v.allowIndexing ? 'Search engines may index public pages' : 'Hidden from search engines'}</span>
                  <span className="block text-[11.5px] text-muted">{v.allowIndexing ? 'robots.txt allows crawling of public pages and points to the sitemap.' : 'robots.txt blocks all crawlers and every page carries noindex. Recommended for internal tools.'}</span>
                </span>
              </span>
              <Switch checked={v.allowIndexing} onCheckedChange={(c) => setV({ ...v, allowIndexing: c })} aria-label="Allow indexing" />
            </label>
            <InlineNotice>Signed-in areas (admin, workspaces, account, API) are always excluded and marked noindex, whatever this setting says. Lead data is never exposed to crawlers.</InlineNotice>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Google Search Console verification" hint="Paste only the content value from the HTML tag method."><Input value={v.googleVerification} placeholder="e.g. 3kXv9…" className="font-mono text-[12px]" onChange={(e) => setV({ ...v, googleVerification: e.target.value.trim() })} /></Field>
              <Field label="Bing Webmaster verification" hint="Optional, the msvalidate.01 content value."><Input value={v.bingVerification} className="font-mono text-[12px]" onChange={(e) => setV({ ...v, bingVerification: e.target.value.trim() })} /></Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Sitemap" description="The list of public pages offered to search engines at /sitemap.xml." actions={<Switch checked={v.sitemapEnabled} onCheckedChange={(c) => setV({ ...v, sitemapEnabled: c })} aria-label="Enable sitemap" />} />
          <CardBody className={cn('grid gap-3', !v.sitemapEnabled && 'pointer-events-none opacity-50')}>
            <PathList values={v.sitemapPaths} onChange={(sitemapPaths) => setV({ ...v, sitemapPaths })} origin={origin} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => window.open('/sitemap.xml', '_blank', 'noopener')}><ExternalLink /> Open sitemap.xml</Button>
              <Button size="sm" variant="ghost" onClick={() => window.open('/robots.txt', '_blank', 'noopener')}><ExternalLink /> Open robots.txt</Button>
            </div>
          </CardBody>
        </Card>
        <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate(v)} onReset={() => setV(value)} />
      </div>

      <div className="flex flex-col gap-4 xl:sticky xl:top-20 xl:self-start">
        <Card>
          <CardHeader title="Google result preview" />
          <CardBody>
            <div className="rounded-lg border border-border bg-white p-4 font-[arial,sans-serif] text-[#202124]">
              <div className="flex items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <span className="grid size-7 place-items-center rounded-full border border-[#ecedef] bg-[#f1f3f4]">{assets.data && <img src={assets.data.branding.faviconUrl} alt="" className="size-4" />}</span>
                <span className="min-w-0"><span className="block truncate text-[13px] leading-tight">{productName}</span><span className="block truncate text-[11.5px] leading-tight text-[#4d5156]">{origin || 'https://example.com'}</span></span>
              </div>
              <div className="mt-1.5 truncate text-[18px] leading-snug text-[#1a0dab]">{title}</div>
              <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-[#4d5156]">{v.description || 'Add a meta description to control this text.'}</div>
            </div>
            {!v.allowIndexing && <p className="mt-2 text-[11px] text-subtle">Preview only — indexing is currently off.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Link preview" description="How a shared link looks in chat and social apps." />
          <CardBody>
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="grid aspect-[1200/630] place-items-center bg-surface-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {assets.data?.branding.ogImageUrl ? <img src={assets.data.branding.ogImageUrl} alt="" className="h-full w-full object-cover" /> : <span className="flex flex-col items-center gap-1 text-[11px] text-subtle"><ImageIcon className="size-5" />Upload a share image in Branding</span>}
              </div>
              <div className="border-t border-border bg-surface-2 px-3 py-2.5">
                <div className="truncate text-[10.5px] uppercase tracking-wide text-subtle">{origin.replace(/^https?:\/\//, '') || 'example.com'}</div>
                <div className="truncate text-[13px] font-medium">{title}</div>
                <div className="line-clamp-2 text-[11.5px] text-muted">{v.description}</div>
              </div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="robots.txt" description="What crawlers see right now (saved settings)." actions={<Button size="xs" variant="ghost" onClick={() => void loadRobots()}><Search /> Refresh</Button>} />
          <pre className="max-h-48 overflow-auto px-4 py-3 font-mono text-[11.5px] leading-relaxed text-fg-2">{robots ?? '…'}</pre>
        </Card>
      </div>
    </div>
  );
}

function ChipInput({ values, onChange, placeholder, max }: { values: string[]; onChange: (v: string[]) => void; placeholder?: string; max: number }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim().replace(/,$/, '');
    if (t && !values.includes(t) && values.length < max) onChange([...values, t]);
    setDraft('');
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-border-strong bg-surface-2 px-2 py-1.5 focus-within:border-fg/40">
      {values.map((k) => (
        <span key={k} className="flex items-center gap-1 rounded bg-surface-3 py-0.5 pr-1 pl-2 text-[11.5px]">{k}<button type="button" aria-label={`Remove ${k}`} onClick={() => onChange(values.filter((x) => x !== k))} className="rounded p-0.5 text-subtle hover:text-fg"><X className="size-3" /></button></span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1)); }}
        onBlur={add}
        placeholder={values.length ? '' : placeholder}
        className="min-w-[120px] flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-subtle"
      />
    </div>
  );
}

function PathList({ values, onChange, origin }: { values: string[]; onChange: (v: string[]) => void; origin: string }) {
  const [draft, setDraft] = useState('');
  const norm = (p: string) => {
    const t = p.trim();
    if (!t) return '';
    try {
      if (/^https?:\/\//.test(t)) return new URL(t).pathname;
    } catch {}
    return t.startsWith('/') ? t : `/${t}`;
  };
  const add = () => {
    const p = norm(draft);
    if (p && !values.includes(p)) onChange([...values, p]);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-1.5">
      {values.map((p) => (
        <div key={p} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[12px]">
          <span className="min-w-0 flex-1 truncate font-mono"><span className="text-subtle">{origin}</span>{p}</span>
          <button type="button" aria-label={`Remove ${p}`} onClick={() => onChange(values.filter((x) => x !== p))} className="rounded p-1 text-subtle hover:text-fg"><Trash2 className="size-3.5" /></button>
        </div>
      ))}
      <div className="flex gap-2">
        <Input value={draft} placeholder="/pricing" className="font-mono text-[12px]" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <Button onClick={add} disabled={!draft.trim()}><Plus /> Add page</Button>
      </div>
      <p className="text-[11px] text-subtle">Private paths (/admin, /app, /account, /api …) are dropped automatically.</p>
    </div>
  );
}

// ── Appearance ───────────────────────────────────────────────────────

const THEMES = [
  { value: 'light' as const, label: 'Light', icon: Sun, note: 'Paper-white canvas with ink typography.' },
  { value: 'dark' as const, label: 'Dark', icon: Moon, note: 'Deep black surfaces, white type.' },
  { value: 'system' as const, label: 'System', icon: Monitor, note: 'Follows each person’s operating system.' },
];

export function AppearanceSettings({ value }: { value: Appearance }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const save = useSaveSetting('appearance');
  const dirty = JSON.stringify(v) !== JSON.stringify(value);
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <Card>
        <CardHeader title="Default theme" description="Applies to everyone who has not picked their own theme — including the sign-in screens." />
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {THEMES.map((t) => (
            <button key={t.value} type="button" onClick={() => setV({ ...v, defaultTheme: t.value })} aria-pressed={v.defaultTheme === t.value}
              className={cn('rounded-lg border p-2 text-left transition-all', v.defaultTheme === t.value ? 'border-fg ring-1 ring-fg' : 'border-border-strong hover:border-faint')}>
              <div className="flex h-24 overflow-hidden rounded-md">
                {(t.value === 'system' ? (['light', 'dark'] as const) : [t.value]).map((m) => (
                  <div key={m} data-theme={m} className="flex flex-1 gap-1.5 bg-bg p-2">
                    <div className="w-1/4 space-y-1 rounded-sm border border-border bg-surface p-1">{[0, 1, 2].map((i) => <div key={i} className="h-1 rounded-full bg-border-strong" />)}</div>
                    <div className="flex flex-1 flex-col gap-1"><div className="h-2 w-1/2 rounded-sm bg-fg" /><div className="flex-1 rounded-sm border border-border bg-surface shadow-[var(--card-shadow)]" /></div>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-1.5 px-1 text-[12.5px] font-medium"><t.icon className="size-3.5 text-subtle" />{t.label}</div>
              <div className="px-1 text-[11px] text-subtle">{t.note}</div>
            </button>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <label className="flex items-center justify-between gap-4">
            <span><span className="block text-[13px] font-medium">Let people choose their own theme</span><span className="block text-[11.5px] text-subtle">Adds a Light / Dark / System switch to the account menu and the account page. Their choice is remembered on their device.</span></span>
            <Switch checked={v.allowUserChoice} onCheckedChange={(c) => setV({ ...v, allowUserChoice: c })} aria-label="Allow personal theme" />
          </label>
        </CardBody>
      </Card>
      <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate(v, { onSuccess: () => { if (!v.allowUserChoice) setThemePref(v.defaultTheme); } })} onReset={() => setV(value)} />
    </div>
  );
}
