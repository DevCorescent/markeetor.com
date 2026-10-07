'use client';
import { Checkbox as RCheckbox, Dialog as D, DropdownMenu as DM, Popover as P, Switch as RSwitch, Tabs as T, Tooltip as TT } from 'radix-ui';
import { Check, Minus, X } from 'lucide-react';
import { cn } from '@/lib/cn';

// ── Dialog ─────────────────────────────────────────────────────────
export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md' }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const w = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] animate-fade-in" />
        <D.Content className={cn('fixed z-50 flex flex-col border border-border-strong bg-surface shadow-2xl shadow-shade', 'inset-x-0 bottom-0 max-h-[92dvh] w-full rounded-t-2xl pb-[env(safe-area-inset-bottom)] animate-sheet-up', 'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-[10vh] sm:max-h-[80vh] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:rounded-lg sm:pb-0 sm:animate-pop', w)}>
          <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong sm:hidden" aria-hidden />
          <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3 sm:px-5 sm:py-4">
            <div className="min-w-0">
              <D.Title className="text-[15px] font-medium tracking-[-0.015em]">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-xs text-subtle">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close className="rounded p-1 text-subtle hover:bg-surface-3 hover:text-fg" aria-label="Close"><X className="size-4" /></D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-5 max-sm:[&>button]:min-h-9 max-sm:[&>button]:flex-1">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// ── Drawer (side sheet) ─────────────────────────────────────────────
export function Drawer({ open, onOpenChange, title, description, children, footer, width = 'md' }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode; width?: 'md' | 'lg' | 'xl';
}) {
  const w = { md: 'sm:w-[440px]', lg: 'sm:w-[600px]', xl: 'sm:w-[820px]' }[width];
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-overlay animate-fade-in" />
        <D.Content className={cn('fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border-strong bg-surface shadow-2xl shadow-shade animate-slide-in', w)}>
          <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5 sm:py-4">
            <div className="min-w-0">
              <D.Title className="truncate text-[15px] font-medium tracking-[-0.015em]">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-xs text-subtle">{description}</D.Description> : <D.Description className="sr-only">Details</D.Description>}
            </div>
            <D.Close className="rounded p-1 text-subtle hover:bg-surface-3 hover:text-fg" aria-label="Close"><X className="size-4" /></D.Close>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// ── Dropdown menu ──────────────────────────────────────────────────
export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
export function MenuContent({ children, align = 'end', className }: { children: React.ReactNode; align?: 'start' | 'end' | 'center'; className?: string }) {
  return (
    <DM.Portal>
      <DM.Content align={align} sideOffset={6} collisionPadding={8} className={cn('z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[calc(100vw-1rem)] min-w-[180px] overflow-y-auto rounded-md border border-border-strong bg-surface-2 p-1 shadow-xl shadow-shade animate-pop', className)}>
        {children}
      </DM.Content>
    </DM.Portal>
  );
}
export function MenuItem({ children, onSelect, danger, disabled }: { children: React.ReactNode; onSelect?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <DM.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn('flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12.5px] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-3 [&_svg]:size-3.5 [&_svg]:text-subtle', danger ? 'text-danger' : 'text-fg-2')}
    >
      {children}
    </DM.Item>
  );
}
export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <DM.Label className="px-2 py-1.5 text-[10.5px] uppercase tracking-[0.1em] text-subtle">{children}</DM.Label>;
}
export const MenuSeparator = () => <DM.Separator className="my-1 h-px bg-border" />;

// ── Popover ────────────────────────────────────────────────────────
export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export function PopoverContent({ children, className, align = 'end' }: { children: React.ReactNode; className?: string; align?: 'start' | 'end' | 'center' }) {
  return (
    <P.Portal>
      <P.Content align={align} sideOffset={6} collisionPadding={8} className={cn('z-50 max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border-strong bg-surface-2 shadow-xl shadow-shade animate-pop', className)}>
        {children}
      </P.Content>
    </P.Portal>
  );
}

// ── Tooltip ────────────────────────────────────────────────────────
export function Tooltip({ content, children, side = 'top' }: { content: React.ReactNode; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <TT.Provider delayDuration={250}>
      <TT.Root>
        <TT.Trigger asChild>{children}</TT.Trigger>
        <TT.Portal>
          <TT.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded border border-border-strong bg-surface-3 px-2 py-1 text-[11.5px] text-fg-2 shadow-lg animate-fade-in">
            {content}
          </TT.Content>
        </TT.Portal>
      </TT.Root>
    </TT.Provider>
  );
}

// ── Tabs ───────────────────────────────────────────────────────────
export const Tabs = T.Root;
export const TabsContent = T.Content;
export function TabsList({ children, className }: { children: React.ReactNode; className?: string }) {
  return <T.List className={cn('scrollbar-none flex items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-border', className)}>{children}</T.List>;
}
export function TabsTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <T.Trigger
      value={value}
      className="-mb-px shrink-0 border-b border-transparent px-2.5 py-2 text-[12.5px] whitespace-nowrap text-subtle transition-colors hover:text-fg-2 data-[state=active]:border-fg data-[state=active]:text-fg"
    >
      {children}
    </T.Trigger>
  );
}

// ── Checkbox / Switch ──────────────────────────────────────────────
export function Checkbox({ checked, onCheckedChange, disabled, ...rest }: { checked: boolean | 'indeterminate'; onCheckedChange: (v: boolean) => void; disabled?: boolean; 'aria-label'?: string; id?: string }) {
  return (
    <RCheckbox.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      disabled={disabled}
      className="grid size-3.5 shrink-0 place-items-center rounded-[3px] border border-faint bg-surface-2 transition-colors hover:border-muted data-[state=checked]:border-fg data-[state=checked]:bg-fg data-[state=indeterminate]:border-fg data-[state=indeterminate]:bg-fg disabled:opacity-40"
      {...rest}
    >
      <RCheckbox.Indicator className="text-inverse">
        {checked === 'indeterminate' ? <Minus className="size-2.5" strokeWidth={3} /> : <Check className="size-2.5" strokeWidth={3} />}
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

export function Switch({ checked, onCheckedChange, disabled, ...rest }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; 'aria-label'?: string; id?: string }) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className="relative h-[18px] w-8 shrink-0 rounded-full border border-border-strong bg-surface-3 transition-colors data-[state=checked]:border-fg data-[state=checked]:bg-fg disabled:opacity-40"
      {...rest}
    >
      <RSwitch.Thumb className="block size-3 translate-x-[2px] rounded-full bg-muted transition-transform data-[state=checked]:translate-x-[16px] data-[state=checked]:bg-inverse" />
    </RSwitch.Root>
  );
}
