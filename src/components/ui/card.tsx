import { cn } from '@/lib/cn';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-surface shadow-[var(--card-shadow)]', className)} {...props} />;
}

export function CardHeader({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-border px-4 py-3 sm:flex-nowrap', className)}>
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-medium tracking-[-0.01em]">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-subtle">{description}</p>}
      </div>
      {actions && <div className="flex max-w-full min-w-0 flex-wrap items-center gap-1.5 sm:shrink-0">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}

export function Separator({ className }: { className?: string }) {
  return <div role="separator" className={cn('h-px w-full bg-border', className)} />;
}

export function DefinitionList({ items, className }: { items: [React.ReactNode, React.ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(110px,40%)_1fr] gap-x-4 gap-y-2.5 text-[12.5px]', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-subtle">{k}</dt>
          <dd className="min-w-0 text-fg-2 max-sm:break-words sm:truncate">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
