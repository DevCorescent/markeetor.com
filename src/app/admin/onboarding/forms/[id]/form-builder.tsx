'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlignLeft, ArrowDown, ArrowUp, AtSign, Calendar, CheckSquare, ChevronDown, CircleDot, Copy, ExternalLink, Eye, GitBranch, Globe, GripVertical, Hash, Heading, Image as ImageIcon, Link2, List, ListChecks,
  Lock, Minus, Monitor, Phone, Tablet, Pilcrow, Plus, Save, ShieldCheck, Smartphone, Sparkles, Star, Trash2, Type, Upload, X,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PublicFormView, type Brand, type PublicFormData } from '@/components/onboarding/public-form';
import { defaultHomepage, homepageSchema, type Homepage } from '@/lib/homepage';
import { FinderHome, type Headline } from '@/components/onboarding/finder-home';
import { HomeCanvas, HomePanel } from './homepage-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger, Switch, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtInt } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { CORE_KEYS, LAYOUT_TYPES, fid, type FieldType, type FormConfig, type FormField } from '@/lib/onboarding';

type FormRow = { id: string; name: string; slug: string; status: 'DRAFT' | 'PUBLISHED' | 'CLOSED'; config: FormConfig; views: number; isHomepage: boolean; assetUrls: { logo: string | null; cover: string | null } };

const TYPE_META: Record<FieldType, { label: string; icon: React.ComponentType<{ className?: string }>; group: 'Input' | 'Choice' | 'Layout' }> = {
  text: { label: 'Short text', icon: Type, group: 'Input' }, textarea: { label: 'Long text', icon: AlignLeft, group: 'Input' }, email: { label: 'Email', icon: AtSign, group: 'Input' },
  phone: { label: 'Phone', icon: Phone, group: 'Input' }, url: { label: 'Website', icon: Link2, group: 'Input' }, number: { label: 'Number', icon: Hash, group: 'Input' }, date: { label: 'Date', icon: Calendar, group: 'Input' },
  select: { label: 'Dropdown', icon: List, group: 'Choice' }, multiselect: { label: 'Multi-select', icon: ListChecks, group: 'Choice' }, radio: { label: 'Single choice', icon: CircleDot, group: 'Choice' },
  checkbox: { label: 'Checkbox', icon: CheckSquare, group: 'Choice' }, country: { label: 'Country', icon: Globe, group: 'Choice' }, rating: { label: 'Rating', icon: Star, group: 'Choice' }, consent: { label: 'Consent', icon: ShieldCheck, group: 'Choice' },
  heading: { label: 'Heading', icon: Heading, group: 'Layout' }, paragraph: { label: 'Paragraph', icon: Pilcrow, group: 'Layout' }, divider: { label: 'Divider', icon: Minus, group: 'Layout' },
};
const HAS_OPTIONS: FieldType[] = ['select', 'multiselect', 'radio'];
const ACCENTS = ['#0b0b0b', '#2f6fed', '#0f8f6b', '#7a4cf0', '#d9480f', '#c2255c', '#0c8599', '#b08900'];
const isCore = (k: string) => (CORE_KEYS as readonly string[]).includes(k);

export function FormBuilder({ id, brand, origin }: { id: string; brand: Brand; origin: string }) {
  const { data, error, refetch } = useApiQuery<FormRow>(`/api/v1/onboarding/forms/${id}`);
  const [form, setForm] = useState<Omit<FormRow, 'views' | 'assetUrls' | 'isHomepage'> | null>(null);
  const [assets, setAssets] = useState<FormRow['assetUrls']>({ logo: null, cover: null });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('build');
  const [activeStep, setActiveStep] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [view, setView] = useState<'form' | 'home'>('form');
  const [section, setSection] = useState<string | null>(null);
  const [isHome, setIsHome] = useState<boolean | null>(null);
  const headline = useApiQuery<{ headline: Headline }>('/api/v1/onboarding/homepage');

  useEffect(() => {
    if (data && !form) {
      // Materialize the generated landing page once so its section ids stay stable while editing.
      setForm({ id: data.id, name: data.name, slug: data.slug, status: data.status, config: { ...data.config, homepage: data.config.homepage ? homepageSchema.parse(data.config.homepage) : defaultHomepage(data.config.content, brand.productName) } });
      setAssets(data.assetUrls);
    }
  }, [data, form, brand.productName]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const previewData = useMemo<PublicFormData | null>(() => (form ? { slug: form.slug, name: form.name, closed: null, config: form.config, assets } : null), [form, assets]);
  if (error) return <ErrorState description={errorMessage(error)} />;
  if (!form || !previewData) return <div className="grid grid-cols-1 gap-4 lg:grid-cols-[400px_1fr]"><Skeleton className="h-[640px]" /><Skeleton className="h-[640px]" /></div>;

  const c = form.config;
  const patch = (p: Partial<typeof form>) => { setForm({ ...form, ...p }); setDirty(true); };
  const setConfig = (fn: (c: FormConfig) => FormConfig) => patch({ config: fn(c) });
  const setDesign = (p: Partial<FormConfig['design']>) => setConfig((x) => ({ ...x, design: { ...x.design, ...p } }));
  const setContent = (p: Partial<FormConfig['content']>) => setConfig((x) => ({ ...x, content: { ...x.content, ...p } }));
  const setSettings = (p: Partial<FormConfig['settings']>) => setConfig((x) => ({ ...x, settings: { ...x.settings, ...p } }));
  const home: Homepage = c.homepage ?? defaultHomepage(c.content, brand.productName);
  const setHome = (fn: (h: Homepage) => Homepage) => setConfig((x) => ({ ...x, homepage: fn(x.homepage ?? defaultHomepage(x.content, brand.productName)) }));
  const homepageOn = isHome ?? data?.isHomepage ?? false;
  const setHomepage = async (on: boolean) => {
    try {
      await api('/api/v1/onboarding/homepage', { method: 'PUT', body: { formId: on ? id : null } });
      setIsHome(on);
      toast.success(on ? 'This page is now your site homepage' : 'Homepage turned off', { description: on && dirty ? 'Save to publish your latest edits to it.' : undefined });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const switchTab = (t: string) => { setTab(t); setView(t === 'home' ? 'home' : 'form'); };

  const save = async (status?: FormRow['status']) => {
    setSaving(true);
    try {
      await api(`/api/v1/onboarding/forms/${id}`, { method: 'PUT', body: { name: form.name, slug: form.slug, status: status ?? form.status, config: c } });
      if (status) setForm({ ...form, status });
      if (status && status !== 'PUBLISHED' && homepageOn) setIsHome(false);
      setDirty(false);
      toast.success(status === 'PUBLISHED' ? 'Form is live' : status === 'CLOSED' ? 'Form closed' : 'Saved');
      refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const link = `${origin}/join/${form.slug}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 basis-full xl:basis-0 xl:flex-1">
          <div className="mb-1 flex items-center gap-1 text-[11.5px] text-subtle"><Link href="/admin/onboarding?tab=forms" className="hover:text-fg-2">Onboarding</Link><span>/</span><span>Form</span></div>
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Form name" value={form.name} onChange={(e) => patch({ name: e.target.value })} className="min-w-0 flex-1 bg-transparent text-[20px] font-[560] tracking-[-0.025em] outline-none" />
            <Badge tone={form.status === 'PUBLISHED' ? 'ok' : form.status === 'CLOSED' ? 'dim' : 'outline'} dot>{form.status === 'PUBLISHED' ? 'Live' : form.status === 'CLOSED' ? 'Closed' : 'Draft'}</Badge>
            {data && <span className="text-[11.5px] whitespace-nowrap text-subtle">{fmtInt(data.views)} views</span>}
          </div>
        </div>
        <div className="flex items-center rounded-md border border-border-strong bg-surface-2 pl-2.5 text-[12px]">
          <span className="text-subtle">/join/</span>
          <input aria-label="Address" value={form.slug} onChange={(e) => patch({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') })} className="h-8 w-40 bg-transparent font-mono text-[12px] outline-none" />
          <button type="button" aria-label="Copy link" className="h-8 px-2 text-subtle hover:text-fg" onClick={() => { navigator.clipboard.writeText(link); toast.success('Link copied'); }}><Copy className="size-3.5" /></button>
          <a aria-label="Open" href={`/join/${form.slug}${form.status === 'DRAFT' ? '?preview=1' : ''}`} target="_blank" rel="noreferrer" className="flex h-8 items-center px-2 text-subtle hover:text-fg"><ExternalLink className="size-3.5" /></a>
        </div>
        {dirty && <span className="text-[11.5px] text-subtle">Unsaved</span>}
        <Button loading={saving && !dirty} disabled={!dirty || saving} onClick={() => save()}><Save /> Save</Button>
        {form.status === 'PUBLISHED'
          ? <Button variant="outline" disabled={saving} onClick={() => save('CLOSED')}>Close form</Button>
          : <Button variant="primary" disabled={saving} onClick={() => save('PUBLISHED')}><Globe /> {form.status === 'CLOSED' ? 'Reopen' : 'Publish'}</Button>}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[400px_minmax(0,1fr)]">
        <div className="flex max-h-[calc(100vh-150px)] min-h-[600px] flex-col overflow-hidden rounded-xl border border-border bg-surface">
          <Tabs value={tab} onValueChange={switchTab}>
            <TabsList className="mx-3 mt-3"><TabsTrigger value="build">Fields</TabsTrigger><TabsTrigger value="design">Design</TabsTrigger><TabsTrigger value="content">Content</TabsTrigger><TabsTrigger value="settings">Settings</TabsTrigger><TabsTrigger value="home">Homepage</TabsTrigger></TabsList>
          </Tabs>
          <div className="flex-1 overflow-y-auto p-3">
            {tab === 'build' && <FieldsPanel c={c} setConfig={setConfig} activeStep={activeStep} setActiveStep={setActiveStep} selected={selected} setSelected={setSelected} setSettings={setSettings} />}
            {tab === 'design' && <DesignPanel c={c} set={setDesign} formId={id} assets={assets} setAssets={setAssets} />}
            {tab === 'content' && <ContentPanel c={c} set={setContent} />}
            {tab === 'settings' && <SettingsPanel c={c} set={setSettings} />}
            {tab === 'home' && (
              <HomePanel home={home} setHome={setHome} selected={section} setSelected={setSection} isHomepage={homepageOn} published={form.status === 'PUBLISHED'}
                onSetHomepage={setHomepage} onPublishAndSet={async () => { await save('PUBLISHED'); await setHomepage(true); }} origin={origin} content={c.content} productName={brand.productName} />
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-2">
          <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
            <div className="flex gap-1.5"><span className="size-2.5 rounded-full bg-border-strong" /><span className="size-2.5 rounded-full bg-border-strong" /><span className="size-2.5 rounded-full bg-border-strong" /></div>
            <div className="flex rounded-md border border-border-strong p-0.5 text-[11.5px]">
              {(['form', 'home'] as const).map((v) => <button key={v} type="button" onClick={() => setView(v)} className={cn('h-6 rounded px-2', view === v ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{v === 'form' ? 'Form page' : 'Homepage'}</button>)}
            </div>
            <div className="mx-auto flex min-w-0 items-center gap-1.5 rounded-md bg-surface-2 px-3 py-1 font-mono text-[11px] text-subtle"><Lock className="size-3" /><span className="truncate">{(view === 'home' ? `${origin}/` : link).replace(/^https?:\/\//, '')}</span></div>
            <div className="flex rounded-md border border-border-strong p-0.5">
              {(['desktop', 'tablet', 'mobile'] as const).map((d) => <button key={d} type="button" aria-label={d} onClick={() => setDevice(d)} className={cn('flex size-6 items-center justify-center rounded', device === d ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{d === 'desktop' ? <Monitor className="size-3.5" /> : d === 'tablet' ? <Tablet className="size-3.5" /> : <Smartphone className="size-3.5" />}</button>)}
            </div>
          </div>
          <div className="max-h-[calc(100vh-196px)] min-h-[560px] flex-1 overflow-auto">
            <div className={cn('mx-auto transition-[max-width] duration-300', device === 'mobile' ? 'my-4 max-w-[390px] overflow-hidden rounded-[28px] border-[6px] border-fg/80 shadow-xl' : device === 'tablet' ? 'my-4 max-w-[800px] overflow-hidden rounded-[20px] border-[6px] border-fg/80 shadow-xl' : 'max-w-none')}>
              {view === 'home'
                ? home.mode === 'finder'
                  ? <Scaled width={device === 'desktop' ? 1280 : null}><FinderHome form={previewData} homepage={home} brand={brand} headline={headline.data?.headline ?? { total: 0, industries: 0, regions: 0, free: 10 }} preview className={device === 'desktop' ? 'min-h-[820px]' : 'min-h-[760px]'} /></Scaled>
                  : <Scaled width={device === 'desktop' ? 1280 : null}><HomeCanvas form={previewData} home={home} brand={brand} setHome={setHome} selected={section} onSelect={(sid) => { setTab('home'); setSection(sid); }} className={device === 'desktop' ? 'min-h-[calc(100vh-200px)]' : 'min-h-[760px]'} /></Scaled>
                : <PublicFormView key={`${activeStep}-${c.steps.length}`} initialStep={activeStep} form={previewData} brand={brand} preview className={device === 'desktop' ? 'min-h-[calc(100vh-200px)]' : 'min-h-[760px]'} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Renders children at a fixed desktop width and zooms it down to fit, so the preview matches a real screen. */
function Scaled({ width, children }: { width: number | null; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setAvail(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const zoom = width && avail && avail < width ? avail / width : 1;
  return <div ref={ref} className="w-full">{width ? <div style={{ width: zoom < 1 ? width : '100%', zoom }}>{children}</div> : children}</div>;
}

// ── Fields ─────────────────────────────────────────────────────────

function uniqueKey(c: FormConfig, base: string) {
  const keys = new Set(c.fields.map((f) => f.key));
  let i = 1;
  let k = base;
  while (keys.has(k)) k = `${base}${++i}`;
  return k;
}

function newField(c: FormConfig, type: FieldType, step: number): FormField {
  const base: Partial<Record<FieldType, string>> = { email: 'emailAddress', phone: 'phone', url: 'website', country: 'country', consent: 'consent', heading: 'heading', paragraph: 'paragraph', divider: 'divider', rating: 'rating', date: 'date', number: 'number' };
  const label: Partial<Record<FieldType, string>> = { heading: 'Section title', paragraph: 'Add some helpful context here.', consent: 'I agree to the terms and privacy policy.', rating: 'How would you rate…?', checkbox: 'Yes, please' };
  return {
    id: fid(), key: uniqueKey(c, base[type] ?? 'question'), type, label: label[type] ?? TYPE_META[type].label, required: false, width: 'full', step,
    ...(HAS_OPTIONS.includes(type) ? { options: ['Option 1', 'Option 2', 'Option 3'] } : {}),
    ...(type === 'rating' ? { max: 5 } : {}),
  };
}

function FieldsPanel({ c, setConfig, activeStep, setActiveStep, selected, setSelected, setSettings }: {
  c: FormConfig; setConfig: (fn: (c: FormConfig) => FormConfig) => void; activeStep: number; setActiveStep: (n: number) => void; selected: string | null; setSelected: (id: string | null) => void; setSettings: (p: Partial<FormConfig['settings']>) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const step = Math.min(activeStep, c.steps.length - 1);
  const fields = c.fields.filter((f) => f.step === step);
  const sel = c.fields.find((f) => f.id === selected) ?? null;
  const [addOpen, setAddOpen] = useState(false);

  const setStep = (i: number, p: Partial<FormConfig['steps'][number]>) => setConfig((x) => ({ ...x, steps: x.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) }));
  const addStep = () => {
    if (c.steps.length >= 8) return;
    setConfig((x) => ({ ...x, steps: [...x.steps, { id: `s${Date.now().toString(36)}`, title: `Step ${x.steps.length + 1}`, description: '' }] }));
    setActiveStep(c.steps.length);
  };
  const removeStep = (i: number) => {
    if (c.steps.length <= 1) return;
    setConfig((x) => ({ ...x, steps: x.steps.filter((_, j) => j !== i), fields: x.fields.map((f) => (f.step === i ? { ...f, step: Math.max(0, i - 1) } : f.step > i ? { ...f, step: f.step - 1 } : f)) }));
    setActiveStep(Math.max(0, i - 1));
  };
  const moveStep = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= c.steps.length) return;
    setConfig((x) => ({ ...x, steps: arrayMove(x.steps, i, j), fields: x.fields.map((f) => (f.step === i ? { ...f, step: j } : f.step === j ? { ...f, step: i } : f)) }));
    setActiveStep(j);
  };
  const add = (type: FieldType) => {
    const f = newField(c, type, step);
    setConfig((x) => ({ ...x, fields: [...x.fields, f] }));
    setSelected(f.id);
    setAddOpen(false);
  };
  const update = (fidv: string, p: Partial<FormField>) => setConfig((x) => ({ ...x, fields: x.fields.map((f) => (f.id === fidv ? { ...f, ...p } : f)) }));
  const remove = (fidv: string) => { setConfig((x) => ({ ...x, fields: x.fields.filter((f) => f.id !== fidv) })); setSelected(null); };
  const duplicate = (f: FormField) => {
    const copy = { ...f, id: fid(), key: uniqueKey(c, f.key.replace(/\d+$/, '')), label: `${f.label} (copy)` };
    setConfig((x) => { const i = x.fields.findIndex((y) => y.id === f.id); const fs = [...x.fields]; fs.splice(i + 1, 0, copy); return { ...x, fields: fs }; });
    setSelected(copy.id);
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    setConfig((x) => {
      const from = x.fields.findIndex((f) => f.id === e.active.id);
      const to = x.fields.findIndex((f) => f.id === e.over!.id);
      return { ...x, fields: arrayMove(x.fields, from, to) };
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <section>
        <div className="mb-2 flex items-center justify-between"><span className="eyebrow">Steps</span><Button size="xs" variant="ghost" disabled={c.steps.length >= 8} onClick={addStep}><Plus /> Add step</Button></div>
        <div className="flex flex-col gap-1">
          {c.steps.map((s, i) => (
            <div key={s.id} className={cn('rounded-lg border transition-colors', i === step ? 'border-fg bg-surface-2' : 'border-border hover:border-border-strong')}>
              <button type="button" onClick={() => setActiveStep(i)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
                <span className={cn('tnum flex size-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold', i === step ? 'bg-fg text-inverse' : 'bg-surface-3 text-muted')}>{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{s.title || 'Untitled step'}</span>
                <span className="text-[11px] text-subtle">{c.fields.filter((f) => f.step === i && !LAYOUT_TYPES.includes(f.type)).length} fields</span>
              </button>
              {i === step && (
                <div className="flex flex-col gap-2 border-t border-border px-2.5 py-2.5">
                  <Input value={s.title} maxLength={80} onChange={(e) => setStep(i, { title: e.target.value })} placeholder="Step title" className="h-7 text-[12px]" />
                  <Input value={s.description ?? ''} maxLength={200} onChange={(e) => setStep(i, { description: e.target.value })} placeholder="Short description (optional)" className="h-7 text-[12px]" />
                  <div className="flex justify-end gap-0.5">
                    <Button size="icon" variant="ghost" aria-label="Move step up" disabled={i === 0} onClick={() => moveStep(i, -1)}><ArrowUp /></Button>
                    <Button size="icon" variant="ghost" aria-label="Move step down" disabled={i === c.steps.length - 1} onClick={() => moveStep(i, 1)}><ArrowDown /></Button>
                    <Button size="icon" variant="ghost" aria-label="Delete step" disabled={c.steps.length <= 1} onClick={() => removeStep(i)}><Trash2 /></Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <span className="eyebrow">Fields in step {step + 1}</span>
          <Popover open={addOpen} onOpenChange={setAddOpen}>
            <PopoverTrigger asChild><Button size="xs" variant="primary"><Plus /> Add field</Button></PopoverTrigger>
            <PopoverContent className="w-[320px] p-2">
              {(['Input', 'Choice', 'Layout'] as const).map((g) => (
                <div key={g} className="mb-1.5 last:mb-0">
                  <div className="px-1.5 py-1 text-[10.5px] font-medium tracking-wide text-subtle uppercase">{g}</div>
                  <div className="grid grid-cols-3 gap-1">
                    {(Object.keys(TYPE_META) as FieldType[]).filter((t) => TYPE_META[t].group === g).map((t) => {
                      const M = TYPE_META[t];
                      return <button key={t} type="button" onClick={() => add(t)} className="flex flex-col items-center gap-1 rounded-md border border-border px-1 py-2 text-[11px] text-fg-2 hover:border-fg hover:text-fg"><M.icon className="size-4" />{M.label}</button>;
                    })}
                  </div>
                </div>
              ))}
            </PopoverContent>
          </Popover>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1">
              {fields.map((f) => (
                <SortableField key={f.id} f={f} open={selected === f.id} onToggle={() => setSelected(selected === f.id ? null : f.id)}>
                  {sel?.id === f.id && <FieldInspector f={f} c={c} onChange={(p) => update(f.id, p)} onRemove={() => remove(f.id)} onDuplicate={() => duplicate(f)} />}
                </SortableField>
              ))}
              {!fields.length && <div className="rounded-lg border border-dashed border-border-strong px-3 py-6 text-center text-[12px] text-subtle">No fields on this step yet.</div>}
            </div>
          </SortableContext>
        </DndContext>
      </section>

      <section className={cn('rounded-lg border px-3 py-3', c.settings.leadFinder.enabled ? 'border-fg' : 'border-border')}>
        <label className="flex items-start justify-between gap-3">
          <span><span className="flex items-center gap-1.5 text-[12.5px] font-medium"><Sparkles className="size-3.5" />Lead Finder</span><span className="mt-0.5 block text-[11.5px] text-subtle">Shows the AI Lead Finder on the last step so applicants can describe their ideal leads and see live availability.</span></span>
          <Switch checked={c.settings.leadFinder.enabled} onCheckedChange={(v) => setSettings({ leadFinder: { ...c.settings.leadFinder, enabled: v } })} aria-label="Lead Finder" />
        </label>
      </section>
    </div>
  );
}

function SortableField({ f, open, onToggle, children }: { f: FormField; open: boolean; onToggle: () => void; children?: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: f.id });
  const M = TYPE_META[f.type];
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn('rounded-lg border bg-surface', open ? 'border-fg' : 'border-border hover:border-border-strong', isDragging && 'z-10 shadow-lg')}>
      <div className="flex items-center gap-1.5 px-1.5 py-1.5">
        <button type="button" aria-label="Drag to reorder" className="flex h-6 w-5 cursor-grab items-center justify-center text-subtle active:cursor-grabbing" {...attributes} {...listeners}><GripVertical className="size-3.5" /></button>
        <M.icon className="size-3.5 shrink-0 text-muted" />
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className="truncate text-[12.5px]">{f.type === 'divider' ? 'Divider' : f.label || <i className="text-subtle">No label</i>}</span>
          {f.required && <span className="text-[11px] text-danger">*</span>}
          {isCore(f.key) && <Lock className="size-3 shrink-0 text-subtle" aria-label="Required by the platform" />}
          {f.showIf && <GitBranch className="size-3 shrink-0 text-subtle" aria-label="Conditional" />}
          {f.width === 'half' && <span className="rounded bg-surface-3 px-1 text-[9.5px] text-subtle">½</span>}
        </button>
        <ChevronDown className={cn('size-3.5 text-subtle transition-transform', open && 'rotate-180')} />
      </div>
      {children}
    </div>
  );
}

function FieldInspector({ f, c, onChange, onRemove, onDuplicate }: { f: FormField; c: FormConfig; onChange: (p: Partial<FormField>) => void; onRemove: () => void; onDuplicate: () => void }) {
  const core = isCore(f.key);
  const layout = LAYOUT_TYPES.includes(f.type);
  const others = c.fields.filter((x) => x.id !== f.id && !LAYOUT_TYPES.includes(x.type));
  const src = others.find((x) => x.key === f.showIf?.key);
  const keyTaken = c.fields.some((x) => x.id !== f.id && x.key === f.key);
  return (
    <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
      {f.type !== 'divider' && <Field label={f.type === 'paragraph' ? 'Text' : f.type === 'consent' || f.type === 'checkbox' ? 'Checkbox text' : 'Label'}>{f.type === 'paragraph' ? <Textarea rows={3} value={f.label} maxLength={160} onChange={(e) => onChange({ label: e.target.value })} /> : <Input value={f.label} maxLength={160} onChange={(e) => onChange({ label: e.target.value })} />}</Field>}
      {!layout && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Type">
              <Select value={f.type} disabled={core} onChange={(e) => onChange({ type: e.target.value as FieldType, ...(HAS_OPTIONS.includes(e.target.value as FieldType) && !f.options?.length ? { options: ['Option 1', 'Option 2'] } : {}) })}>
                {(Object.keys(TYPE_META) as FieldType[]).filter((t) => !LAYOUT_TYPES.includes(t)).map((t) => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
              </Select>
            </Field>
            <Field label="Width"><Select value={f.width} onChange={(e) => onChange({ width: e.target.value as 'full' | 'half' })}><option value="full">Full row</option><option value="half">Half row</option></Select></Field>
          </div>
          {!['checkbox', 'consent', 'rating', 'radio', 'country'].includes(f.type) && <Field label="Placeholder"><Input value={f.placeholder ?? ''} maxLength={160} onChange={(e) => onChange({ placeholder: e.target.value || undefined })} /></Field>}
          <Field label="Help text"><Input value={f.help ?? ''} maxLength={300} onChange={(e) => onChange({ help: e.target.value || undefined })} placeholder="Shown under the field" /></Field>
          {HAS_OPTIONS.includes(f.type) && (
            <Field label="Options" hint="One per line">
              <Textarea rows={Math.min(8, Math.max(3, f.options?.length ?? 3))} value={(f.options ?? []).join('\n')} onChange={(e) => onChange({ options: e.target.value.split('\n').map((s) => s.slice(0, 120)).slice(0, 50) })} onBlur={() => onChange({ options: (f.options ?? []).map((s) => s.trim()).filter(Boolean) })} />
            </Field>
          )}
          {(f.type === 'number' || f.type === 'rating') && (
            <div className="grid grid-cols-2 gap-2">
              {f.type === 'number' && <Field label="Min"><Input type="number" value={f.min ?? ''} onChange={(e) => onChange({ min: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>}
              <Field label={f.type === 'rating' ? 'Stars' : 'Max'}><Input type="number" min={f.type === 'rating' ? 3 : undefined} max={f.type === 'rating' ? 10 : undefined} value={f.max ?? ''} onChange={(e) => onChange({ max: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
            </div>
          )}
          {(f.type === 'text' || f.type === 'textarea') && <Field label="Max length"><Input type="number" min={1} max={5000} value={f.maxLength ?? ''} onChange={(e) => onChange({ maxLength: e.target.value === '' ? undefined : Math.max(1, Math.min(5000, Math.round(Number(e.target.value)))) })} placeholder="No limit" /></Field>}
          {!['consent', 'multiselect', 'rating'].includes(f.type) && <Field label="Default value"><Input value={f.defaultValue ?? ''} maxLength={500} onChange={(e) => onChange({ defaultValue: e.target.value || undefined })} /></Field>}
          <Field label="Answer key" hint={core ? 'Required by the platform to create the workspace' : keyTaken ? 'Another field already uses this key' : 'Used in exports and conditions'} error={keyTaken ? 'Duplicate key' : undefined}>
            <Input value={f.key} disabled={core} maxLength={40} className="font-mono text-[12px]" onChange={(e) => onChange({ key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '').replace(/^[^a-zA-Z]+/, '') })} />
          </Field>
          <label className="flex items-center justify-between text-[12.5px]">Required<Switch checked={f.required || core} disabled={core} onCheckedChange={(v) => onChange({ required: v })} aria-label="Required" /></label>
        </>
      )}
      <div className="rounded-lg bg-surface-2 px-2.5 py-2.5">
        <label className="flex items-center justify-between text-[12px] font-medium"><span className="flex items-center gap-1.5"><GitBranch className="size-3.5" />Conditional logic</span><Switch checked={Boolean(f.showIf)} disabled={core || !others.length} onCheckedChange={(v) => onChange({ showIf: v ? { key: others[0].key, op: 'equals', value: others[0].options?.[0] ?? '' } : null })} aria-label="Conditional" /></label>
        {f.showIf && (
          <div className="mt-2 flex flex-col gap-1.5">
            <span className="text-[11px] text-subtle">Show this field only when</span>
            <Select value={f.showIf.key} onChange={(e) => onChange({ showIf: { ...f.showIf!, key: e.target.value } })} className="h-7 text-[12px]">{others.map((o) => <option key={o.id} value={o.key}>{o.label || o.key}</option>)}</Select>
            <div className="grid grid-cols-[110px_1fr] gap-1.5">
              <Select value={f.showIf.op} onChange={(e) => onChange({ showIf: { ...f.showIf!, op: e.target.value as 'equals' } })} className="h-7 text-[12px]"><option value="equals">is</option><option value="not_equals">is not</option><option value="contains">contains</option><option value="filled">is answered</option><option value="empty">is empty</option></Select>
              {!['filled', 'empty'].includes(f.showIf.op) && (src?.options?.length
                ? <Select value={f.showIf.value ?? ''} onChange={(e) => onChange({ showIf: { ...f.showIf!, value: e.target.value } })} className="h-7 text-[12px]">{src.options.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
                : <Input value={f.showIf.value ?? ''} maxLength={200} onChange={(e) => onChange({ showIf: { ...f.showIf!, value: e.target.value } })} className="h-7 text-[12px]" />)}
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between">
        <Select value={String(f.step)} onChange={(e) => onChange({ step: Number(e.target.value) })} className="h-7 w-auto text-[12px]" aria-label="Move to step">{c.steps.map((s, i) => <option key={s.id} value={i}>Step {i + 1}: {s.title || 'Untitled'}</option>)}</Select>
        <div className="flex gap-0.5">
          <Button size="icon" variant="ghost" aria-label="Duplicate" disabled={core} onClick={onDuplicate}><Copy /></Button>
          <Button size="icon" variant="ghost" aria-label="Delete field" disabled={core} onClick={onRemove}><Trash2 /></Button>
        </div>
      </div>
    </div>
  );
}

// ── Design ─────────────────────────────────────────────────────────

function Choice<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-md border border-border-strong p-0.5">
      {options.map((o) => <button key={o.value} type="button" onClick={() => onChange(o.value)} className={cn('h-7 flex-1 rounded px-1.5 text-[11.5px] whitespace-nowrap', value === o.value ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{o.label}</button>)}
    </div>
  );
}
const Group = ({ title, children }: { title: string; children: React.ReactNode }) => <section className="flex flex-col gap-3 border-b border-border pb-4 last:border-0"><div className="eyebrow">{title}</div>{children}</section>;
const Toggle = ({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <label className="flex items-start justify-between gap-3 text-[12.5px]"><span>{label}{hint && <span className="mt-0.5 block text-[11.5px] text-subtle">{hint}</span>}</span><Switch checked={checked} onCheckedChange={onChange} aria-label={label} /></label>
);

function LayoutIcon({ kind }: { kind: FormConfig['design']['layout'] }) {
  return (
    <div className="flex h-10 w-full gap-0.5 rounded border border-border-strong bg-surface-2 p-1">
      {kind === 'split-left' && <div className="w-2/5 rounded-sm bg-fg/70" />}
      <div className={cn('flex flex-1 flex-col items-center justify-center gap-0.5', kind === 'minimal' && 'items-start pl-1')}>
        <div className={cn('h-1 rounded-full bg-fg/50', kind === 'centered' ? 'w-1/2' : 'w-2/3')} />
        <div className={cn('h-3 rounded-sm border border-fg/30', kind === 'centered' ? 'w-1/2 bg-surface' : 'w-2/3')} />
      </div>
      {kind === 'split-right' && <div className="w-2/5 rounded-sm bg-fg/70" />}
    </div>
  );
}

function DesignPanel({ c, set, formId, assets, setAssets }: { c: FormConfig; set: (p: Partial<FormConfig['design']>) => void; formId: string; assets: FormRow['assetUrls']; setAssets: (a: FormRow['assetUrls']) => void }) {
  const d = c.design;
  return (
    <div className="flex flex-col gap-4">
      <Group title="Brand">
        <div className="grid grid-cols-2 gap-2">
          <AssetPicker formId={formId} kind="logo" url={assets.logo} onChange={(u) => setAssets({ ...assets, logo: u })} />
          <AssetPicker formId={formId} kind="cover" url={assets.cover} onChange={(u) => setAssets({ ...assets, cover: u })} />
        </div>
        <Toggle label="Show logo" checked={d.showLogo} onChange={(v) => set({ showLogo: v })} />
        <div>
          <div className="mb-1.5 text-[12px] font-medium">Accent colour</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {ACCENTS.map((a) => <button key={a} type="button" aria-label={a} onClick={() => set({ accent: a })} className={cn('size-6 rounded-full border-2', d.accent.toLowerCase() === a ? 'border-fg ring-2 ring-surface ring-offset-0' : 'border-transparent')} style={{ background: a }} />)}
            <label className="relative flex h-6 items-center gap-1.5 rounded-full border border-border-strong pr-2 pl-1 text-[11px] text-muted">
              <input type="color" value={d.accent} onChange={(e) => set({ accent: e.target.value })} className="size-4 cursor-pointer rounded-full border-0 bg-transparent p-0" aria-label="Custom colour" />
              <span className="font-mono">{d.accent}</span>
            </label>
          </div>
        </div>
        <Field label="Theme"><Choice value={d.theme} onChange={(v) => set({ theme: v })} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'auto', label: 'Match device' }]} /></Field>
      </Group>
      <Group title="Layout">
        <div className="grid grid-cols-4 gap-1.5">
          {(['split-left', 'centered', 'split-right', 'minimal'] as const).map((l) => (
            <button key={l} type="button" onClick={() => set({ layout: l })} className={cn('flex flex-col items-center gap-1 rounded-lg border p-1.5 text-[10.5px]', d.layout === l ? 'border-fg ring-1 ring-fg' : 'border-border hover:border-border-strong')}>
              <LayoutIcon kind={l} />{l === 'split-left' ? 'Split' : l === 'split-right' ? 'Split right' : l === 'centered' ? 'Card' : 'Minimal'}
            </button>
          ))}
        </div>
        <Field label="Form width"><Choice value={d.width} onChange={(v) => set({ width: v })} options={[{ value: 'narrow', label: 'Narrow' }, { value: 'normal', label: 'Normal' }, { value: 'wide', label: 'Wide' }]} /></Field>
        <Field label="Progress indicator"><Choice value={d.progress} onChange={(v) => set({ progress: v })} options={[{ value: 'steps', label: 'Steps' }, { value: 'bar', label: 'Bar' }, { value: 'none', label: 'Hidden' }]} /></Field>
      </Group>
      <Group title="Background">
        <div className="grid grid-cols-5 gap-1.5">
          {(['plain', 'grid', 'dots', 'gradient', 'image'] as const).map((b) => (
            <button key={b} type="button" onClick={() => set({ background: b })} className={cn('flex flex-col items-center gap-1 rounded-lg border p-1.5 text-[10.5px] capitalize', d.background === b ? 'border-fg ring-1 ring-fg' : 'border-border hover:border-border-strong')}>
              <span className="h-7 w-full rounded border border-border" style={b === 'grid' ? { backgroundImage: 'linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px)', backgroundSize: '6px 6px' } : b === 'dots' ? { backgroundImage: 'radial-gradient(var(--border-strong) 1px,transparent 1px)', backgroundSize: '5px 5px' } : b === 'gradient' ? { background: `linear-gradient(135deg, ${d.gradientFrom}, ${d.gradientTo})` } : b === 'image' ? { background: assets.cover ? `center/cover url(${assets.cover})` : 'var(--surface-3)' } : { background: 'var(--surface)' }} />
              {b}
            </button>
          ))}
        </div>
        {d.background === 'gradient' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="From"><input type="color" value={d.gradientFrom} onChange={(e) => set({ gradientFrom: e.target.value })} className="h-8 w-full cursor-pointer rounded-md border border-border-strong bg-transparent" /></Field>
            <Field label="To"><input type="color" value={d.gradientTo} onChange={(e) => set({ gradientTo: e.target.value })} className="h-8 w-full cursor-pointer rounded-md border border-border-strong bg-transparent" /></Field>
          </div>
        )}
        {d.background === 'image' && !assets.cover && <p className="text-[11.5px] text-subtle">Upload a cover image above to use it as the background.</p>}
      </Group>
      <Group title="Style">
        <Field label="Font"><Choice value={d.font} onChange={(v) => set({ font: v })} options={[{ value: 'geist', label: 'Geist' }, { value: 'inter', label: 'System' }, { value: 'serif', label: 'Serif' }, { value: 'mono', label: 'Mono' }]} /></Field>
        <Field label={`Corner radius · ${d.radius}px`}><input type="range" min={0} max={24} value={d.radius} onChange={(e) => set({ radius: Number(e.target.value) })} className="w-full accent-[var(--fg)]" /></Field>
        <Field label="Inputs"><Choice value={d.inputStyle} onChange={(v) => set({ inputStyle: v })} options={[{ value: 'outline', label: 'Outline' }, { value: 'filled', label: 'Filled' }, { value: 'underline', label: 'Underline' }]} /></Field>
        <Field label="Buttons"><Choice value={d.buttonStyle} onChange={(v) => set({ buttonStyle: v })} options={[{ value: 'solid', label: 'Solid' }, { value: 'outline', label: 'Outline' }, { value: 'pill', label: 'Pill' }]} /></Field>
        <Field label="Density"><Choice value={d.density} onChange={(v) => set({ density: v })} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} /></Field>
        <Toggle label="Animations" hint="Smooth step transitions" checked={d.animate} onChange={(v) => set({ animate: v })} />
      </Group>
    </div>
  );
}

function AssetPicker({ formId, kind, url, onChange }: { formId: string; kind: 'logo' | 'cover'; url: string | null; onChange: (u: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    setBusy(true);
    try { const r = await api<{ url: string }>(`/api/v1/onboarding/forms/${formId}/assets/${kind}`, { body: fd }); onChange(r.url); toast.success(kind === 'logo' ? 'Logo updated' : 'Cover updated'); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const remove = async () => { try { await api(`/api/v1/onboarding/forms/${formId}/assets/${kind}`, { method: 'DELETE' }); onChange(null); } catch (e) { toast.error(errorMessage(e)); } };
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11.5px] font-medium">{kind === 'logo' ? 'Logo' : 'Cover image'}</div>
      <div className="group relative flex h-20 items-center justify-center overflow-hidden rounded-lg border border-dashed border-border-strong bg-surface-2">
        {url ? (kind === 'logo' ? <img src={url} alt="" className="max-h-12 max-w-[80%] object-contain" /> : <img src={url} alt="" className="size-full object-cover" />) : <ImageIcon className="size-5 text-subtle" />}
        <div className="absolute inset-0 flex items-center justify-center gap-1 bg-surface/80 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button size="xs" loading={busy} onClick={() => ref.current?.click()}><Upload /> {url ? 'Replace' : 'Upload'}</Button>
          {url && <Button size="icon" variant="ghost" aria-label="Remove" onClick={remove}><X /></Button>}
        </div>
      </div>
      <div className="text-[10.5px] text-subtle">{kind === 'logo' ? 'PNG/SVG, max 1 MB. Defaults to your brand logo.' : 'Shown in the side panel. Max 5 MB.'}</div>
      <input ref={ref} type="file" hidden accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
    </div>
  );
}

// ── Content ────────────────────────────────────────────────────────

function ListEditor({ items, onChange, max, placeholder }: { items: string[]; onChange: (v: string[]) => void; max: number; placeholder: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((b, i) => (
        <div key={i} className="flex gap-1"><Input value={b} maxLength={140} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} className="h-7 text-[12px]" /><Button size="icon" variant="ghost" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}><X /></Button></div>
      ))}
      {items.length < max && <Button size="xs" variant="ghost" className="self-start" onClick={() => onChange([...items, ''])}><Plus /> {placeholder}</Button>}
    </div>
  );
}

function ContentPanel({ c, set }: { c: FormConfig; set: (p: Partial<FormConfig['content']>) => void }) {
  const t = c.content;
  const split = c.design.layout.startsWith('split');
  return (
    <div className="flex flex-col gap-4">
      <Group title="Headline">
        <Field label="Badge"><Input value={t.badge} maxLength={60} onChange={(e) => set({ badge: e.target.value })} placeholder="e.g. Partner program" /></Field>
        <Field label="Title" required><Input value={t.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} /></Field>
        <Field label="Subtitle"><Textarea rows={2} value={t.subtitle} maxLength={300} onChange={(e) => set({ subtitle: e.target.value })} /></Field>
      </Group>
      <Group title="Side panel">
        {!split && <p className="-mt-1 text-[11.5px] text-subtle">Visible with the split layouts (Design → Layout).</p>}
        <Field label="Heading"><Input value={t.sideTitle} maxLength={120} onChange={(e) => set({ sideTitle: e.target.value })} /></Field>
        <Field label="Text"><Textarea rows={3} value={t.sideText} maxLength={600} onChange={(e) => set({ sideText: e.target.value })} /></Field>
        <Field label="Benefits"><ListEditor items={t.benefits} max={8} placeholder="Add benefit" onChange={(v) => set({ benefits: v })} /></Field>
        <Field label="Stats">
          <div className="flex flex-col gap-1.5">
            {t.stats.map((s, i) => (
              <div key={i} className="grid grid-cols-[80px_1fr_auto] gap-1">
                <Input value={s.value} maxLength={20} placeholder="24h" onChange={(e) => set({ stats: t.stats.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} className="h-7 text-[12px]" />
                <Input value={s.label} maxLength={40} placeholder="Approval time" onChange={(e) => set({ stats: t.stats.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} className="h-7 text-[12px]" />
                <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => set({ stats: t.stats.filter((_, j) => j !== i) })}><X /></Button>
              </div>
            ))}
            {t.stats.length < 4 && <Button size="xs" variant="ghost" className="self-start" onClick={() => set({ stats: [...t.stats, { value: '', label: '' }] })}><Plus /> Add stat</Button>}
          </div>
        </Field>
        <Toggle label="Testimonial" checked={Boolean(t.testimonial)} onChange={(v) => set({ testimonial: v ? { quote: 'We doubled our booked meetings in the first month.', author: 'Alex Morgan', role: 'Founder, Brightside Realty' } : null })} />
        {t.testimonial && (
          <div className="flex flex-col gap-1.5">
            <Textarea rows={2} value={t.testimonial.quote} maxLength={300} onChange={(e) => set({ testimonial: { ...t.testimonial!, quote: e.target.value } })} placeholder="Quote" />
            <div className="grid grid-cols-2 gap-1.5">
              <Input value={t.testimonial.author} maxLength={80} onChange={(e) => set({ testimonial: { ...t.testimonial!, author: e.target.value } })} placeholder="Name" className="h-7 text-[12px]" />
              <Input value={t.testimonial.role} maxLength={80} onChange={(e) => set({ testimonial: { ...t.testimonial!, role: e.target.value } })} placeholder="Role, company" className="h-7 text-[12px]" />
            </div>
          </div>
        )}
      </Group>
      <Group title="Buttons">
        <div className="grid grid-cols-3 gap-2">
          <Field label="Next"><Input value={t.nextLabel} maxLength={40} onChange={(e) => set({ nextLabel: e.target.value })} /></Field>
          <Field label="Back"><Input value={t.backLabel} maxLength={40} onChange={(e) => set({ backLabel: e.target.value })} /></Field>
          <Field label="Submit"><Input value={t.submitLabel} maxLength={40} onChange={(e) => set({ submitLabel: e.target.value })} /></Field>
        </div>
      </Group>
      <Group title="After submitting">
        <Field label="Success title"><Input value={t.successTitle} maxLength={120} onChange={(e) => set({ successTitle: e.target.value })} /></Field>
        <Field label="Success message"><Textarea rows={3} value={t.successMessage} maxLength={600} onChange={(e) => set({ successMessage: e.target.value })} /></Field>
      </Group>
      <Group title="Footer & legal">
        <Field label="Footer text"><Input value={t.footer} maxLength={300} onChange={(e) => set({ footer: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Terms URL"><Input value={t.termsUrl} maxLength={300} onChange={(e) => set({ termsUrl: e.target.value })} placeholder="https://" /></Field>
          <Field label="Privacy URL"><Input value={t.privacyUrl} maxLength={300} onChange={(e) => set({ privacyUrl: e.target.value })} placeholder="https://" /></Field>
        </div>
      </Group>
    </div>
  );
}

// ── Settings ───────────────────────────────────────────────────────

function SettingsPanel({ c, set }: { c: FormConfig; set: (p: Partial<FormConfig['settings']>) => void }) {
  const s = c.settings;
  const lf = s.leadFinder;
  const act = s.activation;
  const num = (k: keyof typeof act, label: string) => <Field label={label}><Input type="number" min={0} value={act[k]} onChange={(e) => set({ activation: { ...act, [k]: Math.max(k === 'maxUsers' ? 1 : 0, Math.round(Number(e.target.value))) } })} /></Field>;
  return (
    <div className="flex flex-col gap-4">
      <Group title="AI Lead Finder">
        <Toggle label="Show the Lead Finder" hint="Applicants chat with the AI to describe their ideal leads and see how many are available. Their criteria are attached to the application." checked={lf.enabled} onChange={(v) => set({ leadFinder: { ...lf, enabled: v } })} />
        {lf.enabled && (
          <>
            <Field label="Title"><Input value={lf.title} maxLength={80} onChange={(e) => set({ leadFinder: { ...lf, title: e.target.value } })} /></Field>
            <Field label="Description"><Textarea rows={2} value={lf.description} maxLength={240} onChange={(e) => set({ leadFinder: { ...lf, description: e.target.value } })} /></Field>
            <Toggle label="Required" hint="Applicants must describe their leads before submitting" checked={lf.required} onChange={(v) => set({ leadFinder: { ...lf, required: v } })} />
          </>
        )}
      </Group>
      <Group title="Approval">
        <Toggle label="Approve automatically" hint="Creates the workspace and emails the login link immediately. Spam and blocked emails are never auto-approved." checked={s.autoApprove} onChange={(v) => set({ autoApprove: v })} />
        <Toggle label="Notify platform admins" hint="In-app alert for every new application" checked={s.notifyAdmins} onChange={(v) => set({ notifyAdmins: v })} />
        <div className="grid grid-cols-2 gap-2">
          {num('maxUsers', 'Max users')}{num('maxActiveLeads', 'Max active leads')}{num('dailyAllocationLimit', 'Daily allocation')}{num('monthlyAllocationLimit', 'Monthly allocation')}
        </div>
        <p className="-mt-1 text-[11px] text-subtle">Limits applied to new workspaces. You can change them per application when approving.</p>
      </Group>
      <Group title="Quality & protection">
        <Toggle label="Require a business email" hint="Rejects Gmail, Outlook and other personal addresses" checked={s.requireBusinessEmail} onChange={(v) => set({ requireBusinessEmail: v })} />
        <Toggle label="Block disposable emails" checked={s.blockDisposable} onChange={(v) => set({ blockDisposable: v })} />
        <Field label="Minimum time to fill (seconds)" hint="Faster submissions are treated as bots. Hidden honeypot protection is always on."><Input type="number" min={0} max={120} value={s.minSeconds} onChange={(e) => set({ minSeconds: Math.max(0, Math.min(120, Math.round(Number(e.target.value)))) })} /></Field>
      </Group>
      <Group title="Confirmation email">
        <Toggle label="Send a confirmation email" checked={s.sendConfirmation} onChange={(v) => set({ sendConfirmation: v })} />
        {s.sendConfirmation && <Field label="Message" hint="Leave empty for the default text"><Textarea rows={3} value={s.confirmationMessage} maxLength={1000} onChange={(e) => set({ confirmationMessage: e.target.value })} /></Field>}
      </Group>
      <Group title="Availability">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Max applications"><Input type="number" min={1} value={s.maxSubmissions ?? ''} placeholder="Unlimited" onChange={(e) => set({ maxSubmissions: e.target.value === '' ? null : Math.max(1, Math.round(Number(e.target.value))) })} /></Field>
          <Field label="Closes at"><Input type="datetime-local" value={s.closesAt ? s.closesAt.slice(0, 16) : ''} onChange={(e) => set({ closesAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></Field>
        </div>
        <Field label="Message when closed"><Input value={s.closedMessage} maxLength={300} onChange={(e) => set({ closedMessage: e.target.value })} /></Field>
      </Group>
      <div className="flex items-center gap-1.5 text-[11px] text-subtle"><Eye className="size-3" />Approval limits and automation settings are never sent to applicants.</div>
    </div>
  );
}
