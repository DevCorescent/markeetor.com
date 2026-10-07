import { AlertTriangle, Inbox, Lock } from 'lucide-react';
import { cn } from '@/lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-surface-3', className)} aria-hidden />;
}

export function EmptyState({ title, description, action, icon: Icon = Inbox, className }: { title: string; description?: string; action?: React.ReactNode; icon?: React.ComponentType<{ className?: string }>; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      <div className="mb-3 grid size-9 place-items-center rounded-md border border-border-strong bg-surface-2">
        <Icon className="size-4 text-muted" />
      </div>
      <p className="text-[13px] font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-xs text-subtle">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = 'Could not load this view', description, action }: { title?: string; description?: string; action?: React.ReactNode }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 grid size-9 place-items-center rounded-md border border-danger/30 bg-danger-dim">
        <AlertTriangle className="size-4 text-danger" />
      </div>
      <p className="text-[13px] font-medium">{title}</p>
      {description && <p className="mt-1 max-w-md text-xs text-subtle">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function NotAvailable({ feature }: { feature: string }) {
  return <EmptyState icon={Lock} title={`${feature} is not enabled`} description="Your platform administrator has not enabled this feature for your workspace." />;
}

export function InlineNotice({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'warn' | 'danger'; children: React.ReactNode; className?: string }) {
  const t = tone === 'warn' ? 'border-warn/25 bg-warn-dim text-warn' : tone === 'danger' ? 'border-danger/25 bg-danger-dim text-danger' : 'border-border-strong bg-surface-2 text-muted';
  return <div className={cn('rounded-md border px-3 py-2 text-xs leading-relaxed', t, className)}>{children}</div>;
}
