import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'solid' | 'outline' | 'danger' | 'warn' | 'ok' | 'dim';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-fg-2 border-border-strong',
  solid: 'bg-fg text-inverse border-fg',
  outline: 'bg-transparent text-muted border-border-strong',
  danger: 'bg-danger-dim text-danger border-danger/25',
  warn: 'bg-warn-dim text-warn border-warn/25',
  ok: 'bg-ok-dim text-ok border-ok/20',
  dim: 'bg-transparent text-subtle border-border',
};

export function Badge({ tone = 'neutral', className, children, dot }: { tone?: Tone; className?: string; children: React.ReactNode; dot?: boolean }) {
  return (
    <span className={cn('inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-medium leading-none whitespace-nowrap', tones[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  FULFILLED: 'ok', PAID: 'ok', DELIVERED: 'ok', DUE: 'warn', AWAITING_PAYMENT: 'warn', WAIVED: 'dim', VOID: 'dim', RELEASED: 'dim', UNAVAILABLE: 'dim', REQUESTED: 'neutral',
  ACTIVE: 'ok', COMPLETED: 'ok', ASSIGNED: 'ok', VALID: 'ok', INSERTED: 'ok', CONVERTED: 'solid', WON: 'solid', SUCCESS: 'ok', SUCCEEDED: 'ok', APPROVED: 'ok', DONE: 'ok', RESOLVED: 'ok', SENT: 'ok',
  PENDING: 'neutral', DRAFT: 'outline', SENDING: 'neutral', VERIFIED: 'ok', UNVERIFIED: 'warn', QUEUED: 'neutral', SCHEDULED: 'neutral', PROCESSING: 'neutral', VALIDATING: 'neutral', PREVIEW_READY: 'neutral', UPLOADED: 'neutral', INVITED: 'neutral', OPEN: 'neutral', IN_PROGRESS: 'neutral', RUNNING: 'neutral', INVESTIGATING: 'warn', NEW: 'outline', UNALLOCATED: 'outline', ALLOCATED: 'neutral',
  PARTIAL: 'warn', SUSPENDED: 'warn', INACTIVE: 'dim', DUPLICATE: 'warn', SKIPPED: 'dim', LOGGED_ONLY: 'dim', MEDIUM: 'neutral', HIGH: 'warn', LOW: 'dim', DISMISSED: 'dim', CANCELLED: 'dim', EXPIRED: 'dim', ARCHIVED: 'dim', REVOKED: 'dim', REASSIGNED: 'dim',
  FAILED: 'danger', INVALID: 'danger', DENIED: 'danger', FAILURE: 'danger', LOST: 'danger', REJECTED: 'danger', CRITICAL: 'danger', URGENT: 'danger', ROLLED_BACK: 'dim', DEACTIVATED: 'dim', DEAD: 'danger',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const label = status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  return <Badge tone={STATUS_TONES[status] ?? 'neutral'} className={className}>{label}</Badge>;
}
