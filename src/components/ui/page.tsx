import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

export function PageHeader({ title, description, actions, crumbs, eyebrow }: {
  title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; crumbs?: { label: string; href?: string }[]; eyebrow?: string;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {crumbs && (
          <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-1 text-[11.5px] text-subtle">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {c.href ? <Link href={c.href} className="hover:text-fg-2">{c.label}</Link> : <span className="text-muted">{c.label}</span>}
                {i < crumbs.length - 1 && <ChevronRight className="size-3" />}
              </span>
            ))}
          </nav>
        )}
        {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
        <h1 className="text-[20px] leading-tight font-[560] tracking-[-0.028em] break-words sm:truncate sm:text-[22px]">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[12.5px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 md:shrink-0 md:justify-end">{actions}</div>}
    </div>
  );
}

export function Section({ title, description, actions, children, className }: { title: string; description?: string; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('mb-6', className)}>
      <div className="mb-2.5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[13.5px] font-medium tracking-[-0.012em]">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-subtle">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub, href, trend, className }: { label: string; value: React.ReactNode; sub?: React.ReactNode; href?: string; trend?: { value: number; label?: string } | null; className?: string }) {
  const body = (
    <>
      <div className="eyebrow">{label}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="tnum text-[20px] leading-none font-[520] tracking-[-0.03em] sm:text-[24px]">{value}</span>
        {trend && Number.isFinite(trend.value) && (
          <span className={cn('tnum text-[11px]', trend.value > 0 ? 'text-fg-2' : trend.value < 0 ? 'text-subtle' : 'text-subtle')}>
            {trend.value > 0 ? '↑' : trend.value < 0 ? '↓' : '·'} {Math.abs(trend.value).toFixed(0)}%{trend.label ? ` ${trend.label}` : ''}
          </span>
        )}
      </div>
      {sub && <div className="mt-1.5 truncate text-[11.5px] text-subtle">{sub}</div>}
    </>
  );
  const cls = cn('block min-w-0 rounded-lg border border-border bg-surface px-3 py-3 sm:px-4 sm:py-3.5 transition-colors', href && 'hover:border-border-strong hover:bg-surface-2', className);
  return href ? <Link href={href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

export function KpiGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6', className)}>{children}</div>;
}

export function DemoDataNotice() {
  return (
    <div className="mb-4 flex items-center gap-2 rounded-md border border-dashed border-border-strong px-3 py-1.5 text-[11.5px] text-subtle">
      <span className="size-1.5 rounded-full bg-warn" aria-hidden />
      Development environment — figures include seeded demo data (organizations marked “Demo”, users on the .test domain).
    </div>
  );
}
