'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowDown, ArrowUp, Braces, Code2, Columns2, Copy, Eye, GripVertical, Heading, Image as ImageIcon, Minus, Monitor, MousePointerClick, MoveVertical,
  Palette, PanelBottom, Pencil, Quote, Redo2, Send, Smartphone, Trash2, Type, Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DEFAULT_SETTINGS, renderEmail } from '@/lib/email/render';
import { newBlock } from '@/lib/email/presets';
import { checkContent } from '@/lib/email/spam-check';
import { SAMPLE_VARIABLES, VARIABLES, type Block, type BlockType, type EmailDesign, type EmailSettings, type VariableDef } from '@/lib/email/types';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Switch, Tooltip } from '@/components/ui/overlay';
import { RichText } from './rich-text';
import { EmailVariablesContext, useEmailVariables } from './variables-context';

export type EmailDoc = { subject: string; preheader: string; design: EmailDesign };
export type Sender = { id: string; label: string; fromName: string; fromEmail: string; status: string; isDefault: boolean; perMinuteLimit?: number };

const BLOCKS: { type: BlockType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { type: 'heading', label: 'Heading', icon: Heading },
  { type: 'text', label: 'Text', icon: Type },
  { type: 'button', label: 'Button', icon: MousePointerClick },
  { type: 'image', label: 'Image', icon: ImageIcon },
  { type: 'columns', label: 'Columns', icon: Columns2 },
  { type: 'quote', label: 'Quote', icon: Quote },
  { type: 'divider', label: 'Divider', icon: Minus },
  { type: 'spacer', label: 'Spacer', icon: MoveVertical },
  { type: 'footer', label: 'Footer', icon: PanelBottom },
  { type: 'html', label: 'HTML', icon: Code2 },
];

const FONT_CSS: Record<EmailSettings['font'], string> = {
  Helvetica: "'Helvetica Neue', Helvetica, Arial, sans-serif", Arial: 'Arial, Helvetica, sans-serif', Inter: "Inter, 'Helvetica Neue', Arial, sans-serif",
  Georgia: "Georgia, 'Times New Roman', serif", Trebuchet: "'Trebuchet MS', Helvetica, sans-serif",
};

/** Undo/redo history; consecutive edits to the same block within 700ms coalesce into one step. */
function useHistory(initial: EmailDoc, onChange: (d: EmailDoc) => void) {
  const past = useRef<EmailDoc[]>([]);
  const future = useRef<EmailDoc[]>([]);
  const last = useRef<{ key: string; at: number }>({ key: '', at: 0 });
  const [counts, setCounts] = useState({ undo: 0, redo: 0 });
  const sync = () => setCounts({ undo: past.current.length, redo: future.current.length });
  const commit = useCallback((prev: EmailDoc, next: EmailDoc, key = '') => {
    const now = Date.now();
    if (!(key && key === last.current.key && now - last.current.at < 700)) {
      past.current.push(prev);
      if (past.current.length > 100) past.current.shift();
    }
    last.current = { key, at: now };
    future.current = [];
    onChange(next);
    setCounts({ undo: past.current.length, redo: 0 });
  }, [onChange]);
  const undo = (cur: EmailDoc) => { const p = past.current.pop(); if (p) { future.current.push(cur); onChange(p); sync(); } };
  const redo = (cur: EmailDoc) => { const f = future.current.pop(); if (f) { past.current.push(cur); onChange(f); sync(); } };
  void initial;
  return { commit, undo, redo, canUndo: counts.undo > 0, canRedo: counts.redo > 0 };
}

export function EmailEditor({ value, onChange, senders, testEndpoint = '/api/v1/email/test', variables = VARIABLES }: { value: EmailDoc; onChange: (d: EmailDoc) => void; senders: Sender[]; testEndpoint?: string; variables?: readonly VariableDef[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [panel, setPanel] = useState<'blocks' | 'style'>('blocks');
  const [testOpen, setTestOpen] = useState(false);
  const hist = useHistory(value, onChange);
  const s = { ...DEFAULT_SETTINGS, ...value.design.settings };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const setDesign = (design: EmailDesign, key = '') => hist.commit(value, { ...value, design }, key);
  const setBlocks = (blocks: Block[], key = '') => setDesign({ ...value.design, blocks }, key);
  const updateBlock = (id: string, patch: Partial<Block>, key?: string) => setBlocks(value.design.blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as Block) : b)), key ?? `block:${id}`);
  const setSettings = (patch: Partial<EmailSettings>) => setDesign({ ...value.design, settings: { ...s, ...patch } }, `settings:${Object.keys(patch).join()}`);

  const insert = (type: BlockType) => {
    const b = newBlock(type);
    const blocks = [...value.design.blocks];
    const selIdx = blocks.findIndex((x) => x.id === selected);
    const footerIdx = blocks.findIndex((x) => x.type === 'footer');
    const at = selIdx >= 0 ? selIdx + 1 : footerIdx >= 0 && type !== 'footer' ? footerIdx : blocks.length;
    blocks.splice(at, 0, b);
    setBlocks(blocks);
    setSelected(b.id);
    setMode('edit');
  };
  const move = (id: string, dir: -1 | 1) => {
    const i = value.design.blocks.findIndex((b) => b.id === id);
    const j = i + dir;
    if (j < 0 || j >= value.design.blocks.length) return;
    setBlocks(arrayMove(value.design.blocks, i, j));
  };
  const duplicate = (id: string) => {
    const i = value.design.blocks.findIndex((b) => b.id === id);
    const copy = { ...value.design.blocks[i], id: newBlock('divider').id } as Block;
    const blocks = [...value.design.blocks];
    blocks.splice(i + 1, 0, copy);
    setBlocks(blocks);
    setSelected(copy.id);
  };
  const remove = (id: string) => {
    if (value.design.blocks.length <= 1) return toast.error('An email needs at least one block');
    setBlocks(value.design.blocks.filter((b) => b.id !== id));
    setSelected(null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = value.design.blocks.findIndex((b) => b.id === e.active.id);
    const to = value.design.blocks.findIndex((b) => b.id === e.over!.id);
    setBlocks(arrayMove(value.design.blocks, from, to));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || (e.target as HTMLElement)?.closest?.('.ProseMirror, input, textarea')) return;
      if (e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) hist.redo(value); else hist.undo(value); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const selectedBlock = value.design.blocks.find((b) => b.id === selected) ?? null;
  const preview = useMemo(() => (mode === 'preview' ? renderEmail(value.design, { preheader: value.preheader, vars: SAMPLE_VARIABLES }).html : ''), [mode, value]);

  return (
    <EmailVariablesContext.Provider value={variables}>
    <div className="grid min-h-[720px] grid-cols-1 overflow-hidden rounded-xl border border-border-strong bg-surface lg:grid-cols-[232px_1fr_300px]">
      {/* Left: palette & styles */}
      <aside className="border-b border-border bg-bg/40 lg:border-r lg:border-b-0">
        <div className="flex border-b border-border p-1.5">
          {(['blocks', 'style'] as const).map((p) => (
            <button key={p} onClick={() => setPanel(p)} className={cn('flex-1 rounded-md py-1.5 text-[11.5px] capitalize transition-colors', panel === p ? 'bg-surface-3 text-fg' : 'text-subtle hover:text-fg')}>{p === 'style' ? 'Global style' : 'Blocks'}</button>
          ))}
        </div>
        {panel === 'blocks' ? (
          <div className="p-3">
            <div className="eyebrow mb-2">Add a block</div>
            <div className="grid grid-cols-2 gap-1.5">
              {BLOCKS.map((b) => (
                <button key={b.type} onClick={() => insert(b.type)} className="group flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-3 text-[11px] text-muted transition-all hover:-translate-y-px hover:border-border-strong hover:text-fg">
                  <b.icon className="size-4 text-subtle group-hover:text-fg" />{b.label}
                </button>
              ))}
            </div>
            <div className="eyebrow mt-5 mb-2">Variables</div>
            <div className="flex flex-col gap-0.5">
              {variables.map((v) => (
                <button key={v.key} onClick={() => { navigator.clipboard.writeText(`{{${v.key}}}`); toast.success(`Copied {{${v.key}}}`); }} className="flex items-center justify-between rounded px-2 py-1 text-left text-[11.5px] text-muted hover:bg-surface-3 hover:text-fg">
                  <span>{v.label}</span><span className="font-mono text-[10px] text-subtle">{`{{${v.key}}}`}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <StylePanel s={s} onChange={setSettings} />
        )}
      </aside>

      {/* Center: canvas */}
      <section className="flex min-w-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <div className="flex items-center rounded-md border border-border bg-surface-2 p-0.5">
            <button onClick={() => setMode('edit')} className={cn('flex h-7 items-center gap-1.5 rounded px-2.5 text-[11.5px]', mode === 'edit' ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}><Pencil className="size-3" />Edit</button>
            <button onClick={() => { setMode('preview'); setSelected(null); }} className={cn('flex h-7 items-center gap-1.5 rounded px-2.5 text-[11.5px]', mode === 'preview' ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}><Eye className="size-3" />Preview</button>
          </div>
          <div className="flex items-center rounded-md border border-border bg-surface-2 p-0.5">
            <Tooltip content="Desktop"><button aria-label="Desktop" onClick={() => setDevice('desktop')} className={cn('grid h-7 w-8 place-items-center rounded', device === 'desktop' ? 'bg-surface-3 text-fg' : 'text-subtle')}><Monitor className="size-3.5" /></button></Tooltip>
            <Tooltip content="Mobile"><button aria-label="Mobile" onClick={() => setDevice('mobile')} className={cn('grid h-7 w-8 place-items-center rounded', device === 'mobile' ? 'bg-surface-3 text-fg' : 'text-subtle')}><Smartphone className="size-3.5" /></button></Tooltip>
          </div>
          <div className="flex items-center">
            <Tooltip content="Undo (⌘Z)"><Button size="icon" variant="ghost" aria-label="Undo" disabled={!hist.canUndo} onClick={() => hist.undo(value)}><Undo2 /></Button></Tooltip>
            <Tooltip content="Redo (⇧⌘Z)"><Button size="icon" variant="ghost" aria-label="Redo" disabled={!hist.canRedo} onClick={() => hist.redo(value)}><Redo2 /></Button></Tooltip>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(renderEmail(value.design, { preheader: value.preheader, vars: {} }).html); toast.success('HTML copied'); }}><Code2 /> Copy HTML</Button>
            <Button size="sm" onClick={() => setTestOpen(true)}><Send /> Send test</Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 border-b border-border px-4 py-3 sm:grid-cols-[1fr_1fr]">
          <SubjectInput label="Subject" value={value.subject} onChange={(v) => hist.commit(value, { ...value, subject: v }, 'subject')} placeholder="What will make them open it?" />
          <SubjectInput label="Preview text" value={value.preheader} onChange={(v) => hist.commit(value, { ...value, preheader: v }, 'preheader')} placeholder="Shown after the subject in most inboxes" />
        </div>

        <div className="dot-canvas flex-1 overflow-auto p-6" onClick={() => setSelected(null)}>
          {mode === 'preview' ? (
            <div className={cn('mx-auto transition-all', device === 'mobile' ? 'w-[390px]' : 'w-full max-w-[720px]')}>
              <InboxCard sender={senders.find((x) => x.isDefault) ?? senders[0]} subject={value.subject} preheader={value.preheader} />
              <div className={cn('overflow-hidden rounded-xl border border-border-strong bg-white shadow-2xl shadow-black/60', device === 'mobile' && 'rounded-[28px] border-[6px] border-[#1f1f1f]')}>
                <iframe title="Email preview" sandbox="" srcDoc={preview} className="block w-full" style={{ height: 760 }} />
              </div>
              <p className="mt-2 text-center text-[11px] text-subtle">Preview uses sample values for personalisation variables.</p>
            </div>
          ) : (
            <div className="email-canvas mx-auto transition-all" style={{ width: device === 'mobile' ? 390 : Math.min(s.width, 720), background: s.background, padding: device === 'mobile' ? 8 : 24, borderRadius: 14 }}>
              <div style={{ background: s.canvas, borderRadius: s.radius, padding: `${device === 'mobile' ? 20 : s.padding}px 0`, color: s.text, fontFamily: FONT_CSS[s.font] }}>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                  <SortableContext items={value.design.blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
                    {value.design.blocks.map((b, i) => (
                      <SortableBlock key={b.id} id={b.id} selected={selected === b.id} onSelect={() => setSelected(b.id)} first={i === 0} last={i === value.design.blocks.length - 1}
                        onUp={() => move(b.id, -1)} onDown={() => move(b.id, 1)} onDuplicate={() => duplicate(b.id)} onRemove={() => remove(b.id)} pad={device === 'mobile' ? 20 : s.padding}>
                        <BlockView block={b} s={s} selected={selected === b.id} onChange={(p) => updateBlock(b.id, p)} />
                      </SortableBlock>
                    ))}
                  </SortableContext>
                </DndContext>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Right: inspector */}
      <aside className="border-t border-border bg-bg/40 lg:border-t-0 lg:border-l">
        {selectedBlock ? (
          <Inspector block={selectedBlock} onChange={(p) => updateBlock(selectedBlock.id, p, `insp:${selectedBlock.id}`)} onRemove={() => remove(selectedBlock.id)} />
        ) : (
          <div className="p-4">
            <div className="eyebrow mb-3">Email</div>
            <p className="text-[12px] leading-relaxed text-muted">Select a block on the canvas to edit it, drag the handle to reorder, or use <span className="text-fg-2">Global style</span> for fonts and colours.</p>
            <div className="mt-5 rounded-lg border border-border p-3 text-[11.5px] leading-relaxed text-subtle">
              Every email should include a footer with <span className="font-mono text-fg-2">{'{{unsubscribeUrl}}'}</span>. Recipients who unsubscribe are suppressed automatically.
            </div>
            {!value.design.blocks.some((b) => (b.type === 'footer' || b.type === 'text' || b.type === 'html') && 'html' in b && b.html.includes('unsubscribeUrl')) && (
              <button onClick={() => insert('footer')} className="mt-3 w-full rounded-md border border-dashed border-warn/40 px-3 py-2 text-[11.5px] text-warn hover:bg-warn-dim">No unsubscribe link found — add footer</button>
            )}
            <SpamCheck doc={value} />
          </div>
        )}
      </aside>
      {testOpen && <TestSend onClose={() => setTestOpen(false)} senders={senders} doc={value} endpoint={testEndpoint} />}
    </div>
    </EmailVariablesContext.Provider>
  );
}

function SubjectInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const variables = useEmailVariables();
  return (
    <label className="flex items-center gap-2 rounded-md border border-border-strong bg-surface-2 pl-2.5 focus-within:border-fg/60">
      <span className="shrink-0 text-[10.5px] uppercase tracking-[0.08em] text-subtle">{label}</span>
      <input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={300} className="h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint" />
      <Menu>
        <MenuTrigger asChild><button type="button" aria-label="Insert variable" className="mr-1 grid size-6 place-items-center rounded text-subtle hover:bg-surface-3 hover:text-fg"><Braces className="size-3.5" /></button></MenuTrigger>
        <MenuContent>
          <MenuLabel>Insert variable</MenuLabel>
          {variables.filter((v) => v.key !== 'unsubscribeUrl').map((v) => (
            <MenuItem key={v.key} onSelect={() => {
              const el = ref.current;
              const pos = el?.selectionStart ?? value.length;
              onChange(`${value.slice(0, pos)}{{${v.key}}}${value.slice(pos)}`);
            }}>{v.label}</MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </label>
  );
}

function InboxCard({ sender, subject, preheader }: { sender?: Sender; subject: string; preheader: string }) {
  const fill = (t: string) => t.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => (SAMPLE_VARIABLES as Record<string, string>)[k] ?? '');
  return (
    <div className="mb-3 flex items-start gap-3 rounded-xl border border-border-strong bg-surface-2 px-4 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-fg text-[12px] font-semibold text-inverse">{(sender?.fromName ?? 'Y')[0]}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2"><span className="truncate text-[13px] font-medium">{sender?.fromName ?? 'Your sender'}</span><span className="text-[11px] text-subtle">now</span></div>
        <div className="truncate text-[12.5px] text-fg-2">{fill(subject) || <span className="text-subtle">(no subject)</span>}</div>
        <div className="truncate text-[12px] text-subtle">{fill(preheader)}</div>
      </div>
    </div>
  );
}

function SortableBlock({ id, selected, onSelect, children, first, last, onUp, onDown, onDuplicate, onRemove, pad }: { id: string; selected: boolean; onSelect: () => void; children: React.ReactNode; first: boolean; last: boolean; onUp: () => void; onDown: () => void; onDuplicate: () => void; onRemove: () => void; pad: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, padding: `0 ${pad}px` }}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      className={cn('group/block relative cursor-default', isDragging && 'z-30 opacity-70')}
    >
      <div className={cn('pointer-events-none absolute inset-y-[-4px] inset-x-[6px] rounded-md border-2 transition-colors', selected ? 'border-[#0a0a0a]' : 'border-transparent group-hover/block:border-[#0a0a0a]/25')} />
      <button {...attributes} {...listeners} aria-label="Drag to reorder" className={cn('absolute top-1/2 -left-1 -translate-y-1/2 cursor-grab rounded bg-[#0a0a0a] p-0.5 text-white opacity-0 transition-opacity group-hover/block:opacity-100', selected && 'opacity-100')}><GripVertical className="size-3.5" /></button>
      {selected && (
        <div className="absolute -top-3 right-2 z-20 flex items-center gap-0.5 rounded-md bg-[#0a0a0a] p-0.5 shadow-lg" onClick={(e) => e.stopPropagation()}>
          {[
            { icon: ArrowUp, label: 'Move up', fn: onUp, disabled: first },
            { icon: ArrowDown, label: 'Move down', fn: onDown, disabled: last },
            { icon: Copy, label: 'Duplicate', fn: onDuplicate },
            { icon: Trash2, label: 'Delete', fn: onRemove },
          ].map(({ icon: I, label, fn, disabled }) => (
            <button key={label} aria-label={label} title={label} disabled={disabled} onClick={fn} className="grid size-6 place-items-center rounded text-white/80 hover:bg-white/15 hover:text-white disabled:opacity-30"><I className="size-3.5" /></button>
          ))}
        </div>
      )}
      <div className="relative">{children}</div>
    </div>
  );
}

function AutoTextarea({ value, onChange, style, className }: { value: string; onChange: (v: string) => void; style?: React.CSSProperties; className?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (ref.current) { ref.current.style.height = 'auto'; ref.current.style.height = `${ref.current.scrollHeight}px`; } }, [value]);
  return <textarea ref={ref} rows={1} value={value} onChange={(e) => onChange(e.target.value)} className={cn('w-full resize-none overflow-hidden bg-transparent outline-none', className)} style={style} />;
}

function BlockView({ block: b, s, selected, onChange }: { block: Block; s: EmailSettings; selected: boolean; onChange: (p: Partial<Block>) => void }) {
  switch (b.type) {
    case 'heading': {
      const size = b.level === 1 ? 30 : b.level === 2 ? 22 : 18;
      return <AutoTextarea value={b.text} onChange={(text) => onChange({ text })} style={{ fontSize: size, lineHeight: 1.25, fontWeight: 600, letterSpacing: '-0.02em', textAlign: b.align, color: s.text, margin: '0 0 14px', fontFamily: 'inherit' }} />;
    }
    case 'text':
      return <RichText html={b.html} onChange={(html) => onChange({ html })} active={selected} className="mb-4" style={{ fontSize: 15, lineHeight: 1.65, textAlign: b.align }} />;
    case 'quote':
      return (
        <div className="mb-4" style={{ borderLeft: `3px solid ${s.accent}`, paddingLeft: 18 }}>
          <RichText html={b.html} onChange={(html) => onChange({ html })} active={selected} style={{ fontSize: 16, lineHeight: 1.6, fontStyle: 'italic' }} />
          {b.author && <div style={{ marginTop: 8, fontSize: 13, color: s.muted }}>— {b.author}</div>}
        </div>
      );
    case 'footer':
      return <RichText html={b.html} onChange={(html) => onChange({ html })} active={selected} className="mt-2" style={{ borderTop: '1px solid #e4e4e7', paddingTop: 20, fontSize: 12, lineHeight: 1.6, color: s.muted, textAlign: 'center' }} />;
    case 'columns':
      return (
        <div className="mb-4 grid grid-cols-2 gap-6" style={{ fontSize: 14, lineHeight: 1.6 }}>
          <RichText html={b.left} onChange={(left) => onChange({ left })} active={selected} />
          <RichText html={b.right} onChange={(right) => onChange({ right })} active={selected} />
        </div>
      );
    case 'button': {
      const solid = b.variant === 'solid';
      return (
        <div style={{ textAlign: b.align, margin: '6px 0 22px' }}>
          <span style={{ display: b.fullWidth ? 'block' : 'inline-block', padding: '13px 26px', borderRadius: s.radius, fontWeight: 600, fontSize: 15, background: solid ? s.accent : 'transparent', color: solid ? s.accentText : s.accent, border: solid ? 'none' : `1.5px solid ${s.accent}`, textAlign: 'center' }}>{b.label || 'Button'}</span>
        </div>
      );
    }
    case 'image':
      return (
        <div style={{ textAlign: b.align, marginBottom: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={b.src} alt={b.alt} style={{ width: `${b.width}%`, display: 'inline-block', borderRadius: Math.min(s.radius, 12) }} />
        </div>
      );
    case 'divider':
      return <div style={{ borderTop: '1px solid #e4e4e7', margin: '8px 0 24px' }} />;
    case 'spacer':
      return <div style={{ height: b.height }} className={cn(selected && 'bg-[repeating-linear-gradient(45deg,#0000000a_0_6px,transparent_6px_12px)]')} />;
    case 'html':
      return <iframe title="HTML block" sandbox="" srcDoc={`<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px">${b.html}</div>`} className="mb-4 h-24 w-full rounded border border-dashed border-[#d4d4d8] bg-white" />;
  }
}

function Inspector({ block: b, onChange, onRemove }: { block: Block; onChange: (p: Partial<Block>) => void; onRemove: () => void }) {
  const alignSel = 'align' in b && (
    <Field label="Alignment">
      <div className="grid grid-cols-3 gap-1">{(['left', 'center', 'right'] as const).map((a) => <button key={a} onClick={() => onChange({ align: a } as Partial<Block>)} className={cn('h-7 rounded-md border text-[11.5px] capitalize', b.align === a ? 'border-fg bg-fg text-inverse' : 'border-border-strong text-muted hover:text-fg')}>{a}</button>)}</div>
    </Field>
  );
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between"><div className="eyebrow">{b.type} block</div><Button size="xs" variant="ghost" onClick={onRemove}><Trash2 /> Remove</Button></div>
      {b.type === 'heading' && (
        <>
          <Field label="Text"><Textarea value={b.text} onChange={(e) => onChange({ text: e.target.value })} /></Field>
          <Field label="Size"><Select value={b.level} onChange={(e) => onChange({ level: Number(e.target.value) as 1 | 2 | 3 })}><option value={1}>Large</option><option value={2}>Medium</option><option value={3}>Small</option></Select></Field>
          {alignSel}
        </>
      )}
      {(b.type === 'text') && <>{alignSel}<p className="text-[11.5px] text-subtle">Edit the text directly on the canvas. Use the floating toolbar for formatting, links and variables.</p></>}
      {b.type === 'button' && (
        <>
          <Field label="Label"><Input value={b.label} onChange={(e) => onChange({ label: e.target.value })} /></Field>
          <Field label="Link" hint="https://, mailto: or a variable"><Input value={b.url} onChange={(e) => onChange({ url: e.target.value })} /></Field>
          <Field label="Style"><Select value={b.variant} onChange={(e) => onChange({ variant: e.target.value as 'solid' | 'outline' })}><option value="solid">Solid</option><option value="outline">Outline</option></Select></Field>
          <label className="flex items-center justify-between text-[12.5px]">Full width<Switch checked={b.fullWidth} onCheckedChange={(v) => onChange({ fullWidth: v })} /></label>
          {alignSel}
        </>
      )}
      {b.type === 'image' && (
        <>
          <Field label="Image URL" hint="Use a publicly hosted https image"><Input value={b.src} onChange={(e) => onChange({ src: e.target.value })} /></Field>
          <Field label="Alt text"><Input value={b.alt} onChange={(e) => onChange({ alt: e.target.value })} /></Field>
          <Field label={`Width · ${b.width}%`}><input type="range" min={10} max={100} value={b.width} onChange={(e) => onChange({ width: Number(e.target.value) })} className="accent-white" /></Field>
          <Field label="Link (optional)"><Input value={b.href} onChange={(e) => onChange({ href: e.target.value })} placeholder="https://" /></Field>
          {alignSel}
        </>
      )}
      {b.type === 'spacer' && <Field label={`Height · ${b.height}px`}><input type="range" min={4} max={160} value={b.height} onChange={(e) => onChange({ height: Number(e.target.value) })} className="accent-white" /></Field>}
      {b.type === 'quote' && <Field label="Attribution"><Input value={b.author} onChange={(e) => onChange({ author: e.target.value })} /></Field>}
      {b.type === 'html' && <Field label="HTML" hint="Sanitized on save: scripts, iframes and event handlers are removed."><Textarea value={b.html} onChange={(e) => onChange({ html: e.target.value })} className="min-h-[220px] font-mono text-[11.5px]" /></Field>}
      {b.type === 'footer' && <p className="text-[11.5px] text-subtle">Keep an unsubscribe link here — insert it from the toolbar’s Variable menu.</p>}
      {(b.type === 'divider' || b.type === 'columns') && <p className="text-[11.5px] text-subtle">{b.type === 'columns' ? 'Edit each column on the canvas. Columns stack on mobile.' : 'A subtle horizontal rule.'}</p>}
    </div>
  );
}

const PALETTES: { name: string; s: Partial<EmailSettings> }[] = [
  { name: 'Mono', s: { background: '#f4f4f5', canvas: '#ffffff', text: '#18181b', muted: '#71717a', accent: '#0a0a0a', accentText: '#ffffff' } },
  { name: 'Ink', s: { background: '#0a0a0a', canvas: '#ffffff', text: '#18181b', muted: '#71717a', accent: '#0a0a0a', accentText: '#ffffff' } },
  { name: 'Paper', s: { background: '#f5f1ea', canvas: '#fffdf9', text: '#1c1917', muted: '#78716c', accent: '#1c1917', accentText: '#fffdf9' } },
  { name: 'Slate', s: { background: '#e2e8f0', canvas: '#ffffff', text: '#0f172a', muted: '#64748b', accent: '#1e293b', accentText: '#ffffff' } },
];

function StylePanel({ s, onChange }: { s: EmailSettings; onChange: (p: Partial<EmailSettings>) => void }) {
  const color = (k: keyof EmailSettings, label: string) => (
    <label className="flex items-center justify-between gap-2 text-[12px] text-muted">
      {label}
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-[10.5px] text-subtle">{String(s[k])}</span>
        <input type="color" value={String(s[k])} onChange={(e) => onChange({ [k]: e.target.value } as Partial<EmailSettings>)} className="size-6 cursor-pointer rounded border border-border-strong bg-transparent" aria-label={label} />
      </span>
    </label>
  );
  return (
    <div className="flex flex-col gap-4 p-3">
      <div>
        <div className="eyebrow mb-2 flex items-center gap-1.5"><Palette className="size-3" />Themes</div>
        <div className="grid grid-cols-2 gap-1.5">
          {PALETTES.map((p) => (
            <button key={p.name} onClick={() => onChange(p.s)} className="rounded-md border border-border p-1.5 text-left text-[11px] text-muted hover:border-border-strong hover:text-fg">
              <div className="mb-1 flex h-7 items-center justify-center rounded" style={{ background: p.s.background }}><div className="h-4 w-10 rounded-sm" style={{ background: p.s.canvas, borderTop: `3px solid ${p.s.accent}` }} /></div>
              {p.name}
            </button>
          ))}
        </div>
      </div>
      <Field label="Font"><Select value={s.font} onChange={(e) => onChange({ font: e.target.value as EmailSettings['font'] })}>{(['Helvetica', 'Inter', 'Arial', 'Georgia', 'Trebuchet'] as const).map((f) => <option key={f}>{f}</option>)}</Select></Field>
      <div className="flex flex-col gap-2">{color('background', 'Background')}{color('canvas', 'Canvas')}{color('text', 'Text')}{color('muted', 'Muted text')}{color('accent', 'Accent / buttons')}{color('accentText', 'Button text')}</div>
      <Field label={`Content width · ${s.width}px`}><input type="range" min={480} max={800} step={10} value={s.width} onChange={(e) => onChange({ width: Number(e.target.value) })} className="accent-white" /></Field>
      <Field label={`Inner padding · ${s.padding}px`}><input type="range" min={12} max={64} value={s.padding} onChange={(e) => onChange({ padding: Number(e.target.value) })} className="accent-white" /></Field>
      <Field label={`Corner radius · ${s.radius}px`}><input type="range" min={0} max={24} value={s.radius} onChange={(e) => onChange({ radius: Number(e.target.value) })} className="accent-white" /></Field>
    </div>
  );
}

function TestSend({ onClose, senders, doc, endpoint }: { onClose: () => void; senders: Sender[]; doc: EmailDoc; endpoint: string }) {
  const [sender, setSender] = useState(senders.find((x) => x.isDefault)?.id ?? senders[0]?.id ?? '');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Send a test email" description="Sample values are used for personalisation variables." size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!sender || !to} onClick={async () => {
        setBusy(true);
        try { await api(endpoint, { body: { smtpAccountId: sender, to, subject: doc.subject || '(no subject)', preheader: doc.preheader, design: doc.design } }); toast.success(`Test sent to ${to}`); onClose(); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
      }}><Send /> Send test</Button></>}>
      {senders.length === 0 ? <p className="text-[12.5px] text-muted">Add an SMTP sender first (Email → Senders).</p> : (
        <div className="flex flex-col gap-3">
          <Field label="From"><Select value={sender} onChange={(e) => setSender(e.target.value)}>{senders.map((x) => <option key={x.id} value={x.id}>{x.label} · {x.fromEmail}{x.status !== 'VERIFIED' ? ' (unverified)' : ''}</option>)}</Select></Field>
          <Field label="Send to"><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@company.com" autoFocus /></Field>
        </div>
      )}
    </Dialog>
  );
}

/** Live inbox-placement check of the content (subject, wording, links, images, unsubscribe). */
function SpamCheck({ doc }: { doc: EmailDoc }) {
  const { score, issues } = useMemo(() => checkContent(doc), [doc]);
  const tone = score >= 85 ? 'text-ok' : score >= 60 ? 'text-warn' : 'text-danger';
  return (
    <div className="mt-5 rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">Spam check</span>
        <span className={cn('tnum text-[13px] font-semibold', tone)}>{score}/100</span>
      </div>
      {!issues.length ? <p className="text-[11.5px] text-ok">No content problems found.</p> : (
        <ul className="flex flex-col gap-1.5">
          {issues.map((i, n) => (
            <li key={n} className="flex gap-1.5 text-[11.5px] leading-snug">
              <span className={cn('mt-[5px] size-1.5 shrink-0 rounded-full', i.level === 'fail' ? 'bg-danger' : i.level === 'warn' ? 'bg-warn' : 'bg-subtle')} />
              <span className="text-muted">{i.message}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[10.5px] text-subtle">Content is only part of it: the sender’s domain setup (SPF, DKIM, DMARC) matters most. Check it under Senders → Deliverability.</p>
    </div>
  );
}
