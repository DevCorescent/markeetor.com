'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlignCenter, AlignLeft, ArrowDown, ArrowUp, ChevronDown, Copy, ExternalLink, Eye, EyeOff, GripVertical, Home, LayoutTemplate, Megaphone, MessageSquareQuote, Plus, RotateCcw, Rows3, Search,
  ShieldQuestion, Sparkles, SquareStack, TextQuote, Trash2, TrendingUp, X,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { HomepageView, SECTION_ICON_MAP } from '@/components/onboarding/homepage-view';
import type { Brand, PublicFormData } from '@/components/onboarding/public-form';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger, Switch } from '@/components/ui/overlay';
import { InlineNotice } from '@/components/ui/states';
import { cn } from '@/lib/cn';
import {
  defaultHomepage, hasFormPlacement, hid, newSection, SECTION_ICONS, SECTION_META, SECTION_TYPES,
  type HomeLink, type HomeSection, type Homepage, type SectionItem, type SectionType,
} from '@/lib/homepage';

const TYPE_ICON: Record<SectionType, React.ComponentType<{ className?: string }>> = {
  hero: LayoutTemplate, logos: Rows3, stats: TrendingUp, features: SquareStack, steps: ArrowDown, testimonials: MessageSquareQuote, faq: ShieldQuestion, cta: Megaphone, form: Home, content: TextQuote,
};
const BACKGROUNDS: { value: HomeSection['background']; label: string; swatch: React.CSSProperties }[] = [
  { value: 'default', label: 'Plain', swatch: { background: 'var(--bg)' } },
  { value: 'muted', label: 'Muted', swatch: { background: 'var(--surface-3)' } },
  { value: 'glow', label: 'Glow', swatch: { background: 'radial-gradient(circle at 50% 0%, var(--fa, #2f6fed) 0%, var(--bg) 70%)' } },
  { value: 'grid', label: 'Grid', swatch: { backgroundImage: 'linear-gradient(var(--border-strong) 1px,transparent 1px),linear-gradient(90deg,var(--border-strong) 1px,transparent 1px)', backgroundSize: '5px 5px' } },
  { value: 'accent', label: 'Accent', swatch: { background: 'var(--fa, #2f6fed)' } },
  { value: 'inverted', label: 'Inverted', swatch: { background: 'var(--fg)' } },
];

function Choice<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-md border border-border-strong p-0.5">
      {options.map((o) => <button key={String(o.value)} type="button" onClick={() => onChange(o.value)} className={cn('flex h-7 flex-1 items-center justify-center gap-1 rounded px-1.5 text-[11.5px] whitespace-nowrap', value === o.value ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{o.label}</button>)}
    </div>
  );
}
const Toggle = ({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <label className="flex items-start justify-between gap-3 text-[12.5px]"><span>{label}{hint && <span className="mt-0.5 block text-[11.5px] text-subtle">{hint}</span>}</span><Switch checked={checked} onCheckedChange={onChange} aria-label={label} /></label>
);
function Collapsible({ title, icon: I, children, defaultOpen = false }: { title: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-lg border border-border">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12.5px] font-medium"><I className="size-3.5 text-muted" />{title}<ChevronDown className={cn('ml-auto size-3.5 text-subtle transition-transform', open && 'rotate-180')} /></button>
      {open && <div className="flex flex-col gap-3 border-t border-border px-3 py-3">{children}</div>}
    </section>
  );
}

// ── Left panel ─────────────────────────────────────────────────────

export function HomePanel({ home, setHome, selected, setSelected, isHomepage, published, onSetHomepage, onPublishAndSet, origin, content, productName }: {
  home: Homepage; setHome: (fn: (h: Homepage) => Homepage) => void; selected: string | null; setSelected: (id: string | null) => void;
  isHomepage: boolean; published: boolean; onSetHomepage: (on: boolean) => Promise<void>; onPublishAndSet: () => Promise<void>; origin: string;
  content: Parameters<typeof defaultHomepage>[0]; productName: string;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const sections = home.sections;
  const setSections = (fn: (s: HomeSection[]) => HomeSection[]) => setHome((h) => ({ ...h, sections: fn(h.sections) }));
  const update = (id: string, p: Partial<HomeSection>) => setSections((ss) => ss.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const add = (type: SectionType) => {
    const s = newSection(type);
    setSections((ss) => {
      const i = ss.findIndex((x) => x.id === selected);
      const out = [...ss];
      out.splice(i >= 0 ? i + 1 : ss.length, 0, s);
      return out;
    });
    setSelected(s.id);
    setAdding(false);
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    setSections((ss) => arrayMove(ss, ss.findIndex((s) => s.id === e.active.id), ss.findIndex((s) => s.id === e.over!.id)));
  };
  const toggleHome = async (on: boolean) => { setBusy(true); try { await onSetHomepage(on); } finally { setBusy(false); } };

  return (
    <div className="flex flex-col gap-4">
      <section className={cn('rounded-lg border px-3.5 py-3', isHomepage ? 'border-fg bg-surface-2' : 'border-border')}>
        <label className="flex items-start justify-between gap-3">
          <span>
            <span className="flex items-center gap-1.5 text-[13px] font-medium"><Home className="size-3.5" />Use as site homepage</span>
            <span className="mt-0.5 block text-[11.5px] leading-snug text-subtle">Everyone who opens <span className="font-mono">{origin.replace(/^https?:\/\//, '')}</span> sees this page. Signed-in users get an “Open dashboard” button.</span>
          </span>
          <Switch checked={isHomepage} disabled={busy || (!published && !isHomepage)} onCheckedChange={toggleHome} aria-label="Use as homepage" />
        </label>
        {!published && !isHomepage && (
          <div className="mt-2.5 flex items-center justify-between gap-2 rounded-md bg-surface-3 px-2.5 py-2 text-[11.5px] text-muted">
            Only published forms can be the homepage.
            <Button size="xs" variant="primary" loading={busy} onClick={async () => { setBusy(true); try { await onPublishAndSet(); } finally { setBusy(false); } }}>Publish & set</Button>
          </div>
        )}
        {isHomepage && <a href="/" target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-medium hover:underline">View live homepage <ExternalLink className="size-3" /></a>}
      </section>

      <section>
        <div className="eyebrow mb-2">Homepage style</div>
        <div className="grid grid-cols-2 gap-2">
          {([['page', 'Landing page', 'Sections, story and the form', LayoutTemplate], ['finder', 'Lead Finder', 'AI search is the whole page', Sparkles]] as const).map(([v, l, h, I]) => (
            <button key={v} type="button" onClick={() => setHome((x) => ({ ...x, mode: v }))} className={cn('flex flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors', home.mode === v ? 'border-fg ring-1 ring-fg' : 'border-border hover:border-border-strong')}>
              <span className="flex h-12 items-center justify-center rounded-md bg-surface-2">
                {v === 'page' ? <span className="flex w-3/4 flex-col gap-1"><span className="h-1.5 w-2/3 rounded-full bg-fg/50" /><span className="h-1 w-full rounded-full bg-fg/20" /><span className="flex gap-1"><span className="h-3 flex-1 rounded-sm bg-fg/15" /><span className="h-3 flex-1 rounded-sm bg-fg/15" /><span className="h-3 flex-1 rounded-sm bg-fg/15" /></span></span>
                  : <span className="flex w-3/4 flex-col items-center gap-1"><span className="h-1.5 w-1/2 rounded-full bg-fg/50" /><span className="flex h-3.5 w-full items-center justify-end rounded-full border border-fg/30 pr-0.5"><span className="size-2.5 rounded-full bg-fg/60" /></span></span>}
              </span>
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium"><I className="size-3.5" />{l}</span>
              <span className="text-[11px] leading-snug text-subtle">{h}</span>
            </button>
          ))}
        </div>
      </section>

      {home.mode === 'finder' && <FinderSettings home={home} setHome={setHome} />}

      {home.mode === 'page' && !hasFormPlacement(home) && <InlineNotice tone="warn">The form isn’t on the page. Add an “Application form” section or set the hero layout to show the form — buttons will link to the separate form page meanwhile.</InlineNotice>}

      {home.mode === 'page' && <section>
        <div className="mb-2 flex items-center justify-between">
          <span className="eyebrow">Sections</span>
          <Popover open={adding} onOpenChange={setAdding}>
            <PopoverTrigger asChild><Button size="xs" variant="primary"><Plus /> Add section</Button></PopoverTrigger>
            <PopoverContent className="w-[330px] p-1.5">
              <div className="grid grid-cols-2 gap-1">
                {SECTION_TYPES.map((t) => {
                  const I = TYPE_ICON[t];
                  return (
                    <button key={t} type="button" onClick={() => add(t)} className="flex items-start gap-2 rounded-md border border-transparent px-2 py-2 text-left hover:border-border-strong hover:bg-surface-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-3"><I className="size-3.5" /></span>
                      <span className="min-w-0"><span className="block text-[12px] font-medium">{SECTION_META[t].label}</span><span className="block text-[10.5px] leading-snug text-subtle">{SECTION_META[t].hint}</span></span>
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <p className="mb-2 text-[11px] text-subtle">Drag to reorder here or directly on the page. Click a section in the preview to edit it.</p>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1">
              {sections.map((s, i) => (
                <SortableRow key={s.id} s={s} open={selected === s.id} onToggle={() => setSelected(selected === s.id ? null : s.id)} onEnabled={(v) => update(s.id, { enabled: v })}>
                  {selected === s.id && (
                    <SectionInspector s={s} onChange={(p) => update(s.id, p)}
                      onMove={(d) => setSections((ss) => (i + d < 0 || i + d >= ss.length ? ss : arrayMove(ss, i, i + d)))}
                      onDuplicate={() => { const copy = { ...s, id: hid(), anchor: '', items: s.items.map((x) => ({ ...x, id: hid() })) }; setSections((ss) => { const o = [...ss]; o.splice(i + 1, 0, copy); return o; }); setSelected(copy.id); }}
                      onRemove={() => { setSections((ss) => ss.filter((x) => x.id !== s.id)); setSelected(null); }} first={i === 0} last={i === sections.length - 1} />
                  )}
                </SortableRow>
              ))}
              {!sections.length && <div className="rounded-lg border border-dashed border-border-strong px-3 py-6 text-center text-[12px] text-subtle">No sections yet.</div>}
            </div>
          </SortableContext>
        </DndContext>
      </section>}

      <Collapsible title="Navigation bar" icon={Rows3}>
        <Toggle label="Show navigation" checked={home.nav.show} onChange={(v) => setHome((h) => ({ ...h, nav: { ...h.nav, show: v } }))} />
        {home.nav.show && (
          <>
            <Toggle label="Stick to the top while scrolling" checked={home.nav.sticky} onChange={(v) => setHome((h) => ({ ...h, nav: { ...h.nav, sticky: v } }))} />
            <Field label="Menu links" hint="Use #anchor to jump to a section"><LinksEditor links={home.nav.links} max={6} anchors={sections.filter((s) => s.enabled).map((s) => s.anchor || s.id)} onChange={(links) => setHome((h) => ({ ...h, nav: { ...h.nav, links } }))} /></Field>
            <Toggle label="Sign-in link" checked={home.nav.showSignIn} onChange={(v) => setHome((h) => ({ ...h, nav: { ...h.nav, showSignIn: v } }))} />
            {home.nav.showSignIn && <Input value={home.nav.signInLabel} maxLength={30} onChange={(e) => setHome((h) => ({ ...h, nav: { ...h.nav, signInLabel: e.target.value } }))} className="h-7 text-[12px]" />}
            <LinkEditor label="Button" value={home.nav.cta} onChange={(cta) => setHome((h) => ({ ...h, nav: { ...h.nav, cta } }))} fallback={{ label: 'Apply now', action: 'form', href: '' }} />
          </>
        )}
      </Collapsible>
      <Collapsible title="Footer" icon={AlignLeft}>
        <Field label="Text"><Textarea rows={2} value={home.footer.text} maxLength={300} onChange={(e) => setHome((h) => ({ ...h, footer: { ...h.footer, text: e.target.value } }))} /></Field>
        <Field label="Links"><LinksEditor links={home.footer.links} max={8} anchors={[]} onChange={(links) => setHome((h) => ({ ...h, footer: { ...h.footer, links } }))} /></Field>
        <Toggle label={`“Powered by ${productName}”`} checked={home.footer.showPoweredBy} onChange={(v) => setHome((h) => ({ ...h, footer: { ...h.footer, showPoweredBy: v } }))} />
      </Collapsible>
      <Collapsible title="Search engines" icon={Search}>
        <Field label="Page title" hint="Defaults to the hero headline"><Input value={home.seo.title} maxLength={120} onChange={(e) => setHome((h) => ({ ...h, seo: { ...h.seo, title: e.target.value } }))} /></Field>
        <Field label="Description"><Textarea rows={2} value={home.seo.description} maxLength={300} onChange={(e) => setHome((h) => ({ ...h, seo: { ...h.seo, description: e.target.value } }))} /></Field>
        <p className="text-[11px] text-subtle">Indexing and the sitemap follow Settings → SEO; the homepage is added to the sitemap automatically.</p>
      </Collapsible>
      <Button variant="ghost" size="sm" className="self-start" onClick={() => { if (window.confirm('Replace the homepage with the recommended template? Your current sections will be lost.')) { setHome(() => defaultHomepage(content, productName)); setSelected(null); } }}><RotateCcw /> Reset to template</Button>
    </div>
  );
}

function StringList({ items, max, placeholder, onChange }: { items: string[]; max: number; placeholder: string; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((t, i) => (
        <div key={i} className="flex gap-1"><Input value={t} maxLength={100} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} className="h-7 text-[12px]" /><Button size="icon" variant="ghost" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}><X /></Button></div>
      ))}
      {items.length < max && <Button size="xs" variant="ghost" className="self-start" onClick={() => onChange([...items, ''])}><Plus /> {placeholder}</Button>}
    </div>
  );
}

function FinderSettings({ home, setHome }: { home: Homepage; setHome: (fn: (h: Homepage) => Homepage) => void }) {
  const f = home.finder;
  const set = (p: Partial<Homepage['finder']>) => setHome((h) => ({ ...h, finder: { ...h.finder, ...p } }));
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex items-center gap-1.5 text-[12.5px] font-medium"><Sparkles className="size-3.5" />Lead Finder page</div>
      <p className="-mt-1 text-[11.5px] leading-snug text-subtle">Visitors describe their ideal customers, chat with the AI, see live matches (contact details hidden) and claim their free leads with your form. Use <span className="font-mono">{'{free}'}</span> and <span className="font-mono">{'{count}'}</span> for live numbers.</p>
      <Field label="Look" hint={f.style === 'mono' ? 'Matches the dashboards: black & white, Geist, follows the platform light/dark theme' : 'Uses the theme, font and accent colour from the Design tab'}>
        <Choice value={f.style} onChange={(v) => set({ style: v })} options={[{ value: 'mono', label: 'Dashboard (B&W)' }, { value: 'brand', label: 'Brand colours' }]} />
      </Field>
      <Field label="Badge"><Input value={f.eyebrow} maxLength={80} onChange={(e) => set({ eyebrow: e.target.value })} /></Field>
      <Field label="Headline" hint="Wrap words in *asterisks* for the accent gradient"><Textarea rows={2} value={f.title} maxLength={140} onChange={(e) => set({ title: e.target.value })} /></Field>
      <Field label="Subtitle"><Textarea rows={2} value={f.subtitle} maxLength={300} onChange={(e) => set({ subtitle: e.target.value })} /></Field>
      <Field label="Search box placeholder"><Input value={f.placeholder} maxLength={140} onChange={(e) => set({ placeholder: e.target.value })} /></Field>
      <Field label="Suggested searches"><StringList items={f.suggestions} max={6} placeholder="Add suggestion" onChange={(v) => set({ suggestions: v })} /></Field>
      <Field label="Trust points"><StringList items={f.trust} max={4} placeholder="Add point" onChange={(v) => set({ trust: v })} /></Field>
      <Field label="Claim button"><Input value={f.claimLabel} maxLength={40} onChange={(e) => set({ claimLabel: e.target.value })} /></Field>
      <Field label="Background"><Choice value={f.background} onChange={(v) => set({ background: v })} options={[{ value: 'grid', label: 'Grid' }, { value: 'glow', label: 'Glow' }, { value: 'aurora', label: 'Grid + glow' }, { value: 'plain', label: 'Plain' }]} /></Field>
      <Toggle label="Live inventory stats" hint="Total leads, industries, regions and free leads" checked={f.showStats} onChange={(v) => set({ showStats: v })} />
      <Toggle label="Quick questions" hint="“Are the first leads really free?” and more" checked={f.showFaq} onChange={(v) => set({ showFaq: v })} />
    </section>
  );
}

function SortableRow({ s, open, onToggle, onEnabled, children }: { s: HomeSection; open: boolean; onToggle: () => void; onEnabled: (v: boolean) => void; children?: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id });
  const I = TYPE_ICON[s.type];
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn('rounded-lg border bg-surface', open ? 'border-fg' : 'border-border hover:border-border-strong', isDragging && 'z-10 shadow-lg', !s.enabled && 'opacity-60')}>
      <div className="flex items-center gap-1.5 px-1.5 py-1.5">
        <button type="button" aria-label="Drag to reorder" className="flex h-6 w-5 cursor-grab items-center justify-center text-subtle active:cursor-grabbing" {...attributes} {...listeners}><GripVertical className="size-3.5" /></button>
        <I className="size-3.5 shrink-0 text-muted" />
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 flex-col text-left">
          <span className="text-[10.5px] text-subtle">{SECTION_META[s.type].label}</span>
          <span className="truncate text-[12.5px]">{s.title.replace(/\*/g, '') || s.eyebrow || s.items.map((x) => x.value || x.title).filter(Boolean).slice(0, 3).join(' · ') || <i className="text-subtle">Untitled</i>}</span>
        </button>
        <button type="button" aria-label={s.enabled ? 'Hide section' : 'Show section'} onClick={() => onEnabled(!s.enabled)} className="grid size-6 place-items-center rounded text-subtle hover:text-fg">{s.enabled ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}</button>
        <ChevronDown className={cn('size-3.5 text-subtle transition-transform', open && 'rotate-180')} />
      </div>
      {children}
    </div>
  );
}

// ── Section inspector ──────────────────────────────────────────────

const ITEM_FIELDS: Partial<Record<SectionType, { label: string; add: string; fields: ('icon' | 'value' | 'title' | 'text' | 'author' | 'role')[]; names?: Partial<Record<string, string>> }>> = {
  hero: { label: 'Highlights', add: 'Add highlight', fields: ['title'], names: { title: 'Highlight' } },
  logos: { label: 'Names', add: 'Add name', fields: ['title'], names: { title: 'Company name' } },
  stats: { label: 'Stats', add: 'Add stat', fields: ['value', 'title', 'text'], names: { value: 'Number', title: 'Label', text: 'Footnote' } },
  features: { label: 'Features', add: 'Add feature', fields: ['icon', 'title', 'text'], names: { text: 'Description' } },
  steps: { label: 'Steps', add: 'Add step', fields: ['title', 'text'], names: { text: 'Description' } },
  testimonials: { label: 'Testimonials', add: 'Add testimonial', fields: ['text', 'author', 'role'], names: { text: 'Quote', author: 'Name', role: 'Role, company' } },
  faq: { label: 'Questions', add: 'Add question', fields: ['title', 'text'], names: { title: 'Question', text: 'Answer' } },
};

function SectionInspector({ s, onChange, onMove, onDuplicate, onRemove, first, last }: { s: HomeSection; onChange: (p: Partial<HomeSection>) => void; onMove: (d: -1 | 1) => void; onDuplicate: () => void; onRemove: () => void; first: boolean; last: boolean }) {
  const items = ITEM_FIELDS[s.type];
  const t = s.type;
  return (
    <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
      {t === 'hero' && (
        <Field label="Layout">
          <div className="grid grid-cols-4 gap-1.5">
            {([['form-right', 'Form right'], ['form-left', 'Form left'], ['centered', 'Centered'], ['split-image', 'Image']] as const).map(([v, l]) => (
              <button key={v} type="button" onClick={() => onChange({ layout: v })} className={cn('flex flex-col items-center gap-1 rounded-md border p-1.5 text-[10px]', s.layout === v ? 'border-fg ring-1 ring-fg' : 'border-border hover:border-border-strong')}>
                <span className="flex h-7 w-full gap-0.5 rounded-sm bg-surface-2 p-0.5">
                  {v === 'centered' ? <span className="mx-auto flex w-2/3 flex-col items-center justify-center gap-0.5"><span className="h-1 w-full rounded-full bg-fg/60" /><span className="h-1 w-2/3 rounded-full bg-fg/30" /></span> : <>
                    <span className={cn('flex flex-1 flex-col justify-center gap-0.5 px-0.5', v === 'form-left' && 'order-2')}><span className="h-1 w-full rounded-full bg-fg/60" /><span className="h-1 w-2/3 rounded-full bg-fg/30" /></span>
                    <span className={cn('w-2/5 rounded-[2px]', v === 'split-image' ? 'bg-fg/40' : 'border border-fg/40 bg-surface')} />
                  </>}
                </span>{l}
              </button>
            ))}
          </div>
        </Field>
      )}
      {t !== 'logos' && <Field label="Eyebrow"><Input value={s.eyebrow} maxLength={60} onChange={(e) => onChange({ eyebrow: e.target.value })} /></Field>}
      {t === 'logos' && <Field label="Label"><Input value={s.eyebrow} maxLength={60} onChange={(e) => onChange({ eyebrow: e.target.value })} placeholder="Trusted by…" /></Field>}
      {t !== 'logos' && <Field label="Title" hint="Wrap words in *asterisks* to highlight them in your accent colour"><Textarea rows={2} value={s.title} maxLength={160} onChange={(e) => onChange({ title: e.target.value })} /></Field>}
      {!['logos', 'content'].includes(t) && <Field label="Subtitle"><Textarea rows={2} value={s.subtitle} maxLength={400} onChange={(e) => onChange({ subtitle: e.target.value })} /></Field>}
      {t === 'content' && <Field label="Text" hint="Blank line = new paragraph"><Textarea rows={7} value={s.body} maxLength={4000} onChange={(e) => onChange({ body: e.target.value })} /></Field>}
      {t === 'form' && <p className="text-[11.5px] text-subtle">Shows the application form with the fields, design and Lead Finder from the other tabs.</p>}
      {(t === 'hero' || t === 'cta') && (
        <>
          <LinkEditor label="Primary button" value={s.primary} onChange={(primary) => onChange({ primary })} fallback={{ label: 'Apply now', action: 'form', href: '' }} />
          <LinkEditor label="Secondary button" value={s.secondary} onChange={(secondary) => onChange({ secondary })} fallback={{ label: 'Sign in', action: 'login', href: '' }} />
        </>
      )}
      {['stats', 'features', 'testimonials'].includes(t) && <Field label="Columns"><Choice value={s.columns} onChange={(v) => onChange({ columns: v })} options={[2, 3, 4].map((n) => ({ value: n, label: String(n) }))} /></Field>}
      {items && <ItemsEditor s={s} spec={items} onChange={(it) => onChange({ items: it })} />}

      <div className="rounded-lg bg-surface-2 px-2.5 py-2.5">
        <div className="mb-2 text-[11.5px] font-medium">Style</div>
        <div className="grid grid-cols-6 gap-1">
          {BACKGROUNDS.map((b) => (
            <button key={b.value} type="button" title={b.label} onClick={() => onChange({ background: b.value })} className={cn('flex flex-col items-center gap-1 rounded-md border p-1 text-[9.5px]', s.background === b.value ? 'border-fg ring-1 ring-fg' : 'border-border hover:border-border-strong')}>
              <span className="h-5 w-full rounded-sm border border-border" style={b.swatch} />{b.label}
            </button>
          ))}
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <Choice value={s.spacing} onChange={(v) => onChange({ spacing: v })} options={[{ value: 'compact', label: 'S' }, { value: 'normal', label: 'M' }, { value: 'spacious', label: 'L' }]} />
          <Choice value={s.align} onChange={(v) => onChange({ align: v })} options={[{ value: 'left', label: <AlignLeft className="size-3.5" /> }, { value: 'center', label: <AlignCenter className="size-3.5" /> }]} />
        </div>
        <div className="mt-2.5 grid grid-cols-[1fr_auto] items-center gap-2">
          <div className="flex items-center rounded-md border border-border-strong bg-surface pl-2 text-[11.5px]"><span className="text-subtle">#</span><input aria-label="Anchor" value={s.anchor} placeholder={s.id} maxLength={40} onChange={(e) => onChange({ anchor: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} className="h-7 min-w-0 flex-1 bg-transparent px-1 font-mono text-[11.5px] outline-none" /></div>
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted">Hide on mobile<Switch checked={s.hideOnMobile} onCheckedChange={(v) => onChange({ hideOnMobile: v })} aria-label="Hide on mobile" /></label>
        </div>
      </div>
      <div className="flex justify-end gap-0.5">
        <Button size="icon" variant="ghost" aria-label="Move up" disabled={first} onClick={() => onMove(-1)}><ArrowUp /></Button>
        <Button size="icon" variant="ghost" aria-label="Move down" disabled={last} onClick={() => onMove(1)}><ArrowDown /></Button>
        <Button size="icon" variant="ghost" aria-label="Duplicate" onClick={onDuplicate}><Copy /></Button>
        <Button size="icon" variant="ghost" aria-label="Delete section" onClick={onRemove}><Trash2 /></Button>
      </div>
    </div>
  );
}

function ItemsEditor({ s, spec, onChange }: { s: HomeSection; spec: NonNullable<(typeof ITEM_FIELDS)[SectionType]>; onChange: (items: SectionItem[]) => void }) {
  const set = (i: number, p: Partial<SectionItem>) => onChange(s.items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const name = (f: string) => spec.names?.[f] ?? f.charAt(0).toUpperCase() + f.slice(1);
  const simple = spec.fields.length === 1;
  return (
    <Field label={spec.label}>
      <div className="flex flex-col gap-1.5">
        {s.items.map((x, i) => (
          <div key={x.id} className={cn('flex gap-1', !simple && 'rounded-md border border-border p-2')}>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {spec.fields.map((f) => f === 'icon' ? (
                <div key={f} className="flex flex-wrap gap-0.5">
                  {SECTION_ICONS.map((ic) => { const I = SECTION_ICON_MAP[ic]; return <button key={ic} type="button" title={ic} onClick={() => set(i, { icon: ic })} className={cn('grid size-6 place-items-center rounded', x.icon === ic ? 'bg-fg text-inverse' : 'text-muted hover:bg-surface-3')}><I className="size-3.5" /></button>; })}
                </div>
              ) : f === 'text' ? (
                <Textarea key={f} rows={2} value={x.text} maxLength={600} placeholder={name(f)} onChange={(e) => set(i, { text: e.target.value })} className="text-[12px]" />
              ) : (
                <Input key={f} value={x[f]} maxLength={f === 'value' ? 24 : 140} placeholder={name(f)} onChange={(e) => set(i, { [f]: e.target.value })} className="h-7 text-[12px]" />
              ))}
            </div>
            <div className="flex flex-col">
              <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => { const o = [...s.items]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; onChange(o); }} className="grid size-6 place-items-center text-subtle hover:text-fg disabled:opacity-30"><ArrowUp className="size-3" /></button>
              <button type="button" aria-label="Remove" onClick={() => onChange(s.items.filter((_, j) => j !== i))} className="grid size-6 place-items-center text-subtle hover:text-danger"><X className="size-3.5" /></button>
            </div>
          </div>
        ))}
        {s.items.length < 16 && <Button size="xs" variant="ghost" className="self-start" onClick={() => onChange([...s.items, { id: hid(), title: '', text: '', value: '', icon: 'sparkles', author: '', role: '' }])}><Plus /> {spec.add}</Button>}
      </div>
    </Field>
  );
}

function LinkEditor({ label, value, onChange, fallback }: { label: string; value: HomeLink | null; onChange: (v: HomeLink | null) => void; fallback: HomeLink }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center justify-between text-[12px] font-medium">{label}<Switch checked={Boolean(value)} onCheckedChange={(v) => onChange(v ? fallback : null)} aria-label={label} /></label>
      {value && (
        <div className="grid grid-cols-[1fr_110px] gap-1.5">
          <Input value={value.label} maxLength={40} onChange={(e) => onChange({ ...value, label: e.target.value })} className="h-7 text-[12px]" placeholder="Label" />
          <Select value={value.action} onChange={(e) => onChange({ ...value, action: e.target.value as HomeLink['action'] })} className="h-7 text-[12px]"><option value="form">Go to form</option><option value="login">Sign in</option><option value="url">Link…</option></Select>
          {value.action === 'url' && <Input value={value.href} maxLength={300} onChange={(e) => onChange({ ...value, href: e.target.value })} className="col-span-2 h-7 text-[12px]" placeholder="https://… or #section" />}
        </div>
      )}
    </div>
  );
}

function LinksEditor({ links, max, anchors, onChange }: { links: { label: string; href: string }[]; max: number; anchors: string[]; onChange: (v: { label: string; href: string }[]) => void }) {
  const listId = `anchors-${max}`;
  return (
    <div className="flex flex-col gap-1.5">
      {links.map((l, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1">
          <Input value={l.label} maxLength={40} placeholder="Label" onChange={(e) => onChange(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className="h-7 text-[12px]" />
          <Input value={l.href} maxLength={300} placeholder="#features or https://" list={listId} onChange={(e) => onChange(links.map((x, j) => (j === i ? { ...x, href: e.target.value } : x)))} className="h-7 font-mono text-[11.5px]" />
          <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => onChange(links.filter((_, j) => j !== i))}><X /></Button>
        </div>
      ))}
      <datalist id={listId}>{anchors.map((a) => <option key={a} value={`#${a}`} />)}</datalist>
      {links.length < max && <Button size="xs" variant="ghost" className="self-start" onClick={() => onChange([...links, { label: '', href: anchors[0] ? `#${anchors[0]}` : '' }])}><Plus /> Add link</Button>}
    </div>
  );
}

// ── Canvas (live, drag-and-drop preview) ───────────────────────────

export function HomeCanvas({ form, home, brand, setHome, selected, onSelect, className }: { form: PublicFormData; home: Homepage; brand: Brand; setHome: (fn: (h: Homepage) => Homepage) => void; selected: string | null; onSelect: (id: string) => void; className?: string }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const enabled = home.sections.filter((s) => s.enabled);
  const setSections = (fn: (s: HomeSection[]) => HomeSection[]) => setHome((h) => ({ ...h, sections: fn(h.sections) }));
  const move = (id: string, d: -1 | 1) => setSections((ss) => {
    const vis = ss.filter((s) => s.enabled);
    const j = vis.findIndex((s) => s.id === id) + d;
    if (j < 0 || j >= vis.length) return ss;
    return arrayMove(ss, ss.findIndex((s) => s.id === id), ss.findIndex((s) => s.id === vis[j].id));
  });
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    setSections((ss) => arrayMove(ss, ss.findIndex((s) => s.id === e.active.id), ss.findIndex((s) => s.id === e.over!.id)));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={enabled.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <HomepageView form={form} homepage={home} brand={brand} preview className={className}
          frame={(s, node) => (
            <CanvasFrame s={s} selected={selected === s.id} onSelect={() => onSelect(s.id)} onMove={(d) => move(s.id, d)}
              onHide={() => setSections((ss) => ss.map((x) => (x.id === s.id ? { ...x, enabled: false } : x)))}
              onRemove={() => setSections((ss) => ss.filter((x) => x.id !== s.id))}>{node}</CanvasFrame>
          )} />
      </SortableContext>
    </DndContext>
  );
}

function CanvasFrame({ s, selected, onSelect, onMove, onHide, onRemove, children }: { s: HomeSection; selected: boolean; onSelect: () => void; onMove: (d: -1 | 1) => void; onHide: () => void; onRemove: () => void; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id });
  const tool = 'grid size-6 place-items-center rounded hover:bg-white/20';
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} onClick={onSelect} className={cn('group/frame relative', isDragging && 'z-50 opacity-80 shadow-2xl')}>
      {children}
      <div className={cn('pointer-events-none absolute inset-0 z-30 transition-shadow', selected ? 'shadow-[inset_0_0_0_2px_#3b82f6]' : 'group-hover/frame:shadow-[inset_0_0_0_1px_rgba(59,130,246,.6)]')} aria-hidden />
      <div className={cn('absolute top-2 left-2 z-40 items-center gap-0.5 rounded-md bg-[#3b82f6] p-0.5 font-sans text-white shadow-lg', selected ? 'flex' : 'hidden group-hover/frame:flex')} onClick={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Drag to reorder" className={cn(tool, 'cursor-grab active:cursor-grabbing')} {...attributes} {...listeners}><GripVertical className="size-3.5" /></button>
        <span className="flex items-center gap-1 px-1 text-[11px] font-medium"><Sparkles className="size-3" />{SECTION_META[s.type].label}</span>
        <button type="button" aria-label="Move up" className={tool} onClick={() => onMove(-1)}><ArrowUp className="size-3.5" /></button>
        <button type="button" aria-label="Move down" className={tool} onClick={() => onMove(1)}><ArrowDown className="size-3.5" /></button>
        <button type="button" aria-label="Hide" className={tool} onClick={() => { onHide(); toast('Section hidden', { description: 'Show it again from the Sections list.' }); }}><EyeOff className="size-3.5" /></button>
        <button type="button" aria-label="Delete" className={tool} onClick={onRemove}><Trash2 className="size-3.5" /></button>
      </div>
    </div>
  );
}
