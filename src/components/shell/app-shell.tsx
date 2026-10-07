'use client';
import { LogOut, Menu as MenuIcon, ShieldCheck, UserCircle } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { Toaster } from 'sonner';
import { api } from '@/lib/api-client';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/overlay';
import type { NavItem } from './nav';
import { Notifications } from './notifications';
import { Providers } from './providers';
import { GlobalSearch } from './search';
import { Sidebar } from './sidebar';
import { StepUpProvider } from './stepup';
import { Watermark } from './watermark';
import type { BrandInfo } from './brand';
import { ThemeSwitcher, ThemeSync, useResolvedTheme } from './theme';

export type ShellProps = {
  nav: NavItem[];
  home: string;
  brand: string;
  sub: string;
  mark: BrandInfo;
  /** Show product/workspace name next to the mark (off when a wordmark logo already says it). */
  showBrandText?: boolean;
  allowThemeChoice?: boolean;
  user: { name: string; email: string; mfaEnabled: boolean };
  roleName: string;
  searchPlaceholder: string;
  watermark?: string | null;
  children: React.ReactNode;
};

export function AppShell({ nav, home, brand, sub, mark, showBrandText = true, allowThemeChoice = true, user, roleName, searchPlaceholder, watermark, children }: ShellProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const theme = useResolvedTheme();
  const initials = user.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const logout = async () => {
    await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => null);
    window.location.href = '/login';
  };

  return (
    <div className="min-h-screen">
      <Sidebar items={nav} home={home} brand={brand} sub={sub} mark={mark} showText={showBrandText} open={open} onClose={close} />
      <div className="lg:pl-[232px]">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-bg/85 px-3 pt-[env(safe-area-inset-top)] backdrop-blur-md sm:gap-3 sm:px-4 md:px-6 [@supports(padding:env(safe-area-inset-top))]:h-[calc(3.5rem+env(safe-area-inset-top))]">
          <button className="-ml-1 grid size-9 shrink-0 place-items-center rounded-md text-muted hover:text-fg lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation"><MenuIcon className="size-[18px]" /></button>
          <div className="flex min-w-0 flex-1 items-center"><GlobalSearch placeholder={searchPlaceholder} /></div>
          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
            <Notifications />
            <Menu>
              <MenuTrigger asChild>
                <button className="ml-1 flex items-center gap-2 rounded-md py-1 pr-1 pl-1 hover:bg-surface-3" aria-label="Account menu">
                  <span className="grid size-7 place-items-center rounded-full border border-border-strong bg-surface-3 text-[10.5px] font-semibold">{initials}</span>
                  <span className="hidden text-left md:block">
                    <span className="block max-w-[140px] truncate text-[12px] leading-tight">{user.name}</span>
                    <span className="block max-w-[140px] truncate text-[10.5px] leading-tight text-subtle">{roleName}</span>
                  </span>
                </button>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>{user.email}</MenuLabel>
                <MenuItem onSelect={() => (window.location.href = '/account')}><UserCircle /> Account & security</MenuItem>
                {!user.mfaEnabled && <MenuItem onSelect={() => (window.location.href = '/account/mfa-setup')}><ShieldCheck /> Enable two-factor</MenuItem>}
                {allowThemeChoice && (
                  <>
                    <MenuSeparator />
                    <div className="flex items-center justify-between gap-3 px-2 py-1.5">
                      <span className="text-[12px] text-muted">Theme</span>
                      <ThemeSwitcher compact />
                    </div>
                  </>
                )}
                <MenuSeparator />
                <MenuItem onSelect={logout}><LogOut /> Sign out</MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1440px] px-3 py-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-4 sm:py-6 md:px-6"><Providers>{children}</Providers></main>
      </div>
      {watermark && <Watermark label={watermark} />}
      <StepUpProvider mfaEnabled={user.mfaEnabled} />
      <ThemeSync />
      <Toaster theme={theme} position="bottom-right" toastOptions={{ style: { background: 'var(--surface-2)', border: '1px solid var(--border-strong)', color: 'var(--fg)', fontSize: 12.5, boxShadow: 'var(--raised-shadow)' } }} />
    </div>
  );
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="text-xs text-subtle hover:text-fg">← {children}</Link>;
}
