'use client';
import { Check, Copy, Ticket } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { fmtDate } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { couponLabel } from '@/lib/pricing';
import type { Offer } from './request-dialog';

/** Coupons the workspace can use right now, as tear-off tickets. Renders nothing when there are none. */
export function CouponOffers({ compact = false, currency = 'USD', className }: { compact?: boolean; currency?: string; className?: string }) {
  const { data } = useApiQuery<{ coupons: Offer[] }>('/api/v1/marketplace/coupons', { refetchInterval: 120_000 });
  const [copied, setCopied] = useState<string | null>(null);
  const list = data?.coupons ?? [];
  if (!list.length) return null;
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); } catch {}
    setCopied(code);
    setTimeout(() => setCopied(null), 1500);
  };
  return (
    <div className={cn('rounded-lg border border-border bg-surface shadow-[var(--card-shadow)]', compact ? 'p-3' : 'p-4', className)}>
      <div className="mb-3 flex items-center gap-2"><Ticket className="size-4" /><span className="text-[13.5px] font-medium">Offers for you</span><span className="text-[11.5px] text-subtle">{list.length} coupon{list.length === 1 ? '' : 's'} available</span></div>
      <div className={cn('grid gap-2.5', compact ? 'sm:grid-cols-2 xl:grid-cols-3' : 'sm:grid-cols-2')}>
        {list.map((c) => (
          <div key={c.code} className="relative flex overflow-hidden rounded-lg border border-border-strong">
            <div className="flex w-[42%] flex-col justify-center bg-fg px-3 py-2.5 text-inverse">
              <div className="text-[17px] leading-tight font-semibold tracking-[-0.02em]">{couponLabel(c, currency).replace(/ \(up to.*\)/, '')}</div>
              <div className="mt-0.5 truncate text-[10.5px] opacity-70">{c.name}</div>
            </div>
            <div className="flex flex-1 flex-col justify-between gap-1.5 border-l border-dashed border-border-strong px-3 py-2.5">
              <div className="text-[11px] leading-snug text-muted">
                {c.description ?? ([c.minLeads ? `Min. ${c.minLeads} leads` : null, c.maxDiscount ? `Up to ${couponLabel({ ...c, type: 'FIXED', value: c.maxDiscount }, currency).replace(' off', '')}` : null, c.firstRequestOnly ? 'First request only' : null].filter(Boolean).join(' · ') || 'Applies to your next request')}
                {c.endsAt && <span className="block text-subtle">Until {fmtDate(c.endsAt)}</span>}
              </div>
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => copy(c.code)} className="flex items-center gap-1 rounded border border-dashed border-border-strong px-1.5 py-0.5 font-mono text-[11.5px] font-semibold hover:border-fg" aria-label={`Copy ${c.code}`}>
                  {c.code}{copied === c.code ? <Check className="size-3 text-ok" /> : <Copy className="size-3 text-subtle" />}
                </button>
                <Link href={`/app/marketplace?coupon=${encodeURIComponent(c.code)}`} className="ml-auto text-[11.5px] font-medium text-fg underline-offset-2 hover:underline">Use</Link>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
