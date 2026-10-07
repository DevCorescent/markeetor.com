'use client';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { cn } from '@/lib/cn';
import { currentThemePref, resolveTheme, setThemePref, type ResolvedTheme, type ThemePref } from '@/lib/theme';

function subscribe(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-pref'] });
  return () => obs.disconnect();
}

/** The theme actually on screen (light/dark), kept in sync with the <html> attribute. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'),
    () => 'dark',
  );
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, currentThemePref, () => 'dark');
}

/** Follows OS light/dark changes while the preference is "system". Mounted once in each shell. */
export function ThemeSync() {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      if (currentThemePref() === 'system') document.documentElement.setAttribute('data-theme', resolveTheme('system'));
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return null;
}

const OPTIONS: { value: ThemePref; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Segmented Light / Dark / System control. `compact` renders icon-only buttons for menus. */
export function ThemeSwitcher({ compact = false, className }: { compact?: boolean; className?: string }) {
  const pref = useThemePref();
  return (
    <div role="radiogroup" aria-label="Theme" className={cn('inline-flex items-center gap-0.5 rounded-md border border-border bg-surface-2 p-0.5', className)}>
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={pref === value}
          aria-label={label}
          title={label}
          onClick={(e) => { e.stopPropagation(); setThemePref(value); }}
          className={cn(
            'flex items-center justify-center gap-1.5 rounded-[5px] text-[11.5px] transition-colors',
            compact ? 'size-7' : 'h-7 px-2.5',
            pref === value ? 'bg-surface text-fg shadow-[var(--raised-shadow)] ring-1 ring-border-strong' : 'text-subtle hover:text-fg',
          )}
        >
          <Icon className="size-3.5" />
          {!compact && label}
        </button>
      ))}
    </div>
  );
}

/** Large visual picker for the account page: a miniature of each theme. */
export function ThemeCards() {
  const pref = useThemePref();
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={pref === value}
          onClick={() => setThemePref(value)}
          className={cn('group rounded-lg border p-2 text-left transition-all', pref === value ? 'border-fg ring-1 ring-fg' : 'border-border-strong hover:border-faint')}
        >
          <ThemeMiniature kind={value} />
          <span className="mt-2 flex items-center gap-1.5 px-1 text-[12.5px] font-medium"><Icon className="size-3.5 text-subtle" />{label}</span>
        </button>
      ))}
    </div>
  );
}

function ThemeMiniature({ kind }: { kind: ThemePref }) {
  const pane = (light: boolean) => (
    <div className={cn('flex h-full flex-1 gap-1.5 p-1.5', light ? 'bg-[#f7f7f5]' : 'bg-[#050505]')}>
      <div className={cn('w-1/4 space-y-1 rounded-sm p-1', light ? 'bg-white ring-1 ring-[#e8e8e4]' : 'bg-[#0b0b0b] ring-1 ring-[#1d1d1d]')}>
        {[0, 1, 2].map((i) => <div key={i} className={cn('h-1 rounded-full', light ? 'bg-[#d9d9d4]' : 'bg-[#2a2a2a]')} />)}
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <div className={cn('h-2 w-1/2 rounded-sm', light ? 'bg-[#0b0b0b]' : 'bg-[#fafafa]')} />
        <div className={cn('flex-1 rounded-sm', light ? 'bg-white ring-1 ring-[#e8e8e4]' : 'bg-[#0b0b0b] ring-1 ring-[#1d1d1d]')} />
      </div>
    </div>
  );
  return (
    <div className="flex h-20 overflow-hidden rounded-md">
      {kind === 'system' ? <>{pane(true)}{pane(false)}</> : pane(kind === 'light')}
    </div>
  );
}
