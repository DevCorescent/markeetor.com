'use client';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { AlignCenter, AlignLeft, AlignRight, Bold, Braces, Italic, Link2, List, ListOrdered, Quote, RemoveFormatting, Strikethrough, Underline } from 'lucide-react';
import { useEffect } from 'react';
import { cn } from '@/lib/cn';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tooltip } from '@/components/ui/overlay';
import { useEmailVariables } from './variables-context';

const SWATCHES = ['#0a0a0a', '#52525b', '#a1a1aa', '#ffffff', '#b91c1c', '#b45309', '#15803d', '#1d4ed8', '#7c3aed'];

function ToolButton({ active, onClick, label, children }: { active?: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={cn('grid size-7 place-items-center rounded transition-colors [&_svg]:size-3.5', active ? 'bg-fg text-inverse' : 'text-muted hover:bg-surface-3 hover:text-fg')}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function RichToolbar({ editor, className }: { editor: Editor; className?: string }) {
  const variables = useEmailVariables();
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), quote: e.isActive('blockquote'), link: e.isActive('link'),
      left: e.isActive({ textAlign: 'left' }), center: e.isActive({ textAlign: 'center' }), right: e.isActive({ textAlign: 'right' }),
    }),
  });
  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL (https://…, mailto:… or {{unsubscribeUrl}})', prev ?? 'https://');
    if (url === null) return;
    if (!url) return editor.chain().focus().extendMarkRange('link').unsetLink().run();
    if (!/^(https?:\/\/|mailto:|\{\{)/i.test(url)) return;
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };
  return (
    <div className={cn('flex flex-wrap items-center gap-0.5 rounded-md border border-border-strong bg-surface-2 p-1 shadow-xl', className)} onMouseDown={(e) => e.stopPropagation()}>
      <ToolButton label="Bold" active={s.bold} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></ToolButton>
      <ToolButton label="Italic" active={s.italic} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></ToolButton>
      <ToolButton label="Underline" active={s.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline /></ToolButton>
      <ToolButton label="Strikethrough" active={s.strike} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></ToolButton>
      <span className="mx-1 h-4 w-px bg-border-strong" />
      <ToolButton label="Link" active={s.link} onClick={setLink}><Link2 /></ToolButton>
      <ToolButton label="Bulleted list" active={s.bullet} onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></ToolButton>
      <ToolButton label="Numbered list" active={s.ordered} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></ToolButton>
      <ToolButton label="Quote" active={s.quote} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote /></ToolButton>
      <span className="mx-1 h-4 w-px bg-border-strong" />
      <ToolButton label="Align left" active={s.left} onClick={() => editor.chain().focus().setTextAlign('left').run()}><AlignLeft /></ToolButton>
      <ToolButton label="Align center" active={s.center} onClick={() => editor.chain().focus().setTextAlign('center').run()}><AlignCenter /></ToolButton>
      <ToolButton label="Align right" active={s.right} onClick={() => editor.chain().focus().setTextAlign('right').run()}><AlignRight /></ToolButton>
      <span className="mx-1 h-4 w-px bg-border-strong" />
      <Menu>
        <MenuTrigger asChild>
          <button type="button" aria-label="Text colour" onMouseDown={(e) => e.preventDefault()} className="grid size-7 place-items-center rounded text-muted hover:bg-surface-3 hover:text-fg">
            <span className="size-3.5 rounded-full border border-border-strong" style={{ background: (editor.getAttributes('textStyle').color as string) || '#0a0a0a' }} />
          </button>
        </MenuTrigger>
        <MenuContent align="start" className="min-w-0">
          <div className="grid grid-cols-5 gap-1 p-1.5">
            {SWATCHES.map((c) => <button key={c} type="button" aria-label={c} onClick={() => editor.chain().focus().setColor(c).run()} className="size-5 rounded-full border border-border-strong" style={{ background: c }} />)}
            <button type="button" aria-label="Default colour" onClick={() => editor.chain().focus().unsetColor().run()} className="grid size-5 place-items-center rounded-full border border-border-strong text-[9px] text-subtle">×</button>
          </div>
        </MenuContent>
      </Menu>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" aria-label="Insert variable" onMouseDown={(e) => e.preventDefault()} className="flex h-7 items-center gap-1 rounded px-1.5 text-[11.5px] text-muted hover:bg-surface-3 hover:text-fg"><Braces className="size-3.5" />Variable</button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuLabel>Personalisation</MenuLabel>
          {variables.map((v) => (
            <MenuItem key={v.key} onSelect={() => (v.key === 'unsubscribeUrl'
              ? editor.chain().focus().insertContent('<a href="{{unsubscribeUrl}}">Unsubscribe</a>').run()
              : editor.chain().focus().insertContent(`{{${v.key}}}`).run())}>
              <span className="flex-1">{v.label}</span><span className="font-mono text-[10.5px] text-subtle">{`{{${v.key}}}`}</span>
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <ToolButton label="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}><RemoveFormatting /></ToolButton>
    </div>
  );
}

/** Inline rich-text editor used inside email blocks. Output HTML is sanitized server-side on save. */
export function RichText({ html, onChange, placeholder, active, style, className }: { html: string; onChange: (html: string) => void; placeholder?: string; active: boolean; style?: React.CSSProperties; className?: string }) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, HTMLAttributes: { target: '_blank', rel: 'noopener' } }, codeBlock: false }),
      TextStyle, Color,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: placeholder ?? 'Write something…' }),
    ],
    content: html,
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    editorProps: { attributes: { class: 'email-rte outline-none' } },
  });
  useEffect(() => {
    if (editor && !editor.isFocused && html !== editor.getHTML()) editor.commands.setContent(html, { emitUpdate: false });
  }, [html, editor]);
  if (!editor) return <div className={className} style={style} dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <div className={cn('relative', className)} style={style}>
      {active && <RichToolbar editor={editor} className="absolute -top-11 left-0 z-20" />}
      <EditorContent editor={editor} />
    </div>
  );
}
