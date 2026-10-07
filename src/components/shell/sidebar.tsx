'use client';
import { useEffect } from 'react';
import { BarChart3, Building2, CheckSquare, Database, Gauge, KanbanSquare, LayoutGrid, ScrollText, Settings, ShieldCheck, Shuffle, Stamp, Upload, Users, UsersRound, Workflow, KeyRound, Mail, Megaphone, Receipt, Store, X, Filter, ClipboardList, Sunrise, TrendingUp, LineChart, Truck, HeartPulse, Landmark, BellRing, Activity, Rocket } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { BrandMark, type BrandInfo } from './brand';
import type { NavItem } from './nav';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  dashboard: LayoutGrid, analytics: BarChart3, leads: Database, imports: Upload, distribution: Shuffle, orgs: Building2,
  users: Users, roles: KeyRound, approvals: Stamp, security: ShieldCheck, audit: ScrollText, automation: Workflow, settings: Settings,
  pipeline: KanbanSquare, email: Mail, marketplace: Store, announcements: Megaphone, billing: Receipt, funnels: Filter, onboarding: ClipboardList, tasks: CheckSquare, team: UsersRound, gauge: Gauge, today: Sunrise, roi: TrendingUp, insights: LineChart, suppliers: Truck, health: HeartPulse, finance: Landmark, alerts: BellRing, system: Activity, marketing: Rocket,
};

export function Sidebar({ items, home, brand, sub, mark, showText = true, open, onClose }: { items: NavItem[]; home: string; brand: string; sub: string; mark: BrandInfo; showText?: boolean; open: boolean; onClose: () => void }) {
  const path = usePathname();
  const groups = [...new Set(items.map((i) => i.group ?? ''))];
  const isActive = (href: string) => (href === home ? path === href : path === href || path.startsWith(`${href}/`));
  // Phone drawer: Escape closes it and the page behind stops scrolling while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [open, onClose]);

  return (
    <>
      <div className={cn('fixed inset-0 z-40 bg-overlay animate-fade-in lg:hidden', open ? 'block' : 'hidden')} onClick={onClose} aria-hidden />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-[min(280px,86vw)] flex-col border-r border-border bg-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] transition-transform duration-200 lg:w-[232px] lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Primary"
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-border px-4">
          <Link href={home} className="flex min-w-0 items-center gap-2.5">
            <BrandMark brand={mark} size={showText ? 24 : 26} />
            {showText && (
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold tracking-[-0.02em]">{brand}</span>
                <span className="block truncate text-[10.5px] tracking-wide text-subtle">{sub}</span>
              </span>
            )}
          </Link>
          <button className="grid size-9 place-items-center rounded-md text-subtle hover:text-fg lg:hidden" onClick={onClose} aria-label="Close navigation"><X className="size-4" /></button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2.5 py-3">
          {groups.map((g) => (
            <div key={g} className="mb-4">
              {g && <div className="eyebrow mb-1 px-2 !text-[10px]">{g}</div>}
              <ul className="flex flex-col gap-px">
                {items.filter((i) => (i.group ?? '') === g).map((item) => {
                  const Icon = ICONS[item.key] ?? LayoutGrid;
                  const active = isActive(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onClose}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'group relative flex h-10 items-center gap-2.5 rounded-md px-2 text-[13.5px] transition-colors lg:h-8 lg:text-[12.5px]',
                          active ? 'bg-surface-3 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                        )}
                      >
                        {active && <span className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-fg" aria-hidden />}
                        <Icon className={cn('size-[15px]', active ? 'text-fg' : 'text-subtle group-hover:text-fg-2')} />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className="border-t border-border px-4 py-3 text-[10.5px] leading-relaxed text-subtle">
          Access is logged. Contact details are masked by default.
        </div>
      </aside>
    </>
  );
}
