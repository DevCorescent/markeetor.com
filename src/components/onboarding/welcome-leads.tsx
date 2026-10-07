'use client';
import { ArrowRight, Gift, Hourglass, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

export type Welcome = { status: string; count: number; summary: string | null; at: string };

/** First-run card for businesses that came from the homepage/form Lead Finder: where their free leads are. */
export function WelcomeLeads({ w }: { w: Welcome }) {
  const key = `lcrm.welcome.${w.at}`;
  const [hidden, setHidden] = useState(true);
  useEffect(() => { try { setHidden(localStorage.getItem(key) === '1'); } catch { setHidden(false); } }, [key]);
  if (hidden) return null;
  const delivered = w.status === 'FULFILLED' || w.status === 'PARTIAL';
  const pending = w.status === 'PENDING';
  if (!delivered && !pending) return null;
  return (
    <div className="relative mb-4 overflow-hidden rounded-xl border border-border-strong bg-surface p-5">
      <div className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full bg-fg/[0.06] blur-3xl" aria-hidden />
      <button type="button" aria-label="Dismiss" onClick={() => { try { localStorage.setItem(key, '1'); } catch {} setHidden(true); }} className="absolute top-3 right-3 grid size-7 place-items-center rounded-md text-subtle hover:bg-surface-3 hover:text-fg"><X className="size-4" /></button>
      <div className="relative flex flex-col gap-4 md:flex-row md:items-center">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-fg text-inverse">{delivered ? <Gift className="size-5" /> : <Hourglass className="size-5" />}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-[560] tracking-[-0.015em]">{delivered ? `Your ${w.count} free lead${w.count === 1 ? ' is' : 's are'} in your workspace` : `Your ${w.count} free leads are being prepared`}</div>
          <p className="mt-1 text-[13px] text-muted">
            {delivered ? 'Picked from what you searched for' : 'They’ll appear in your leads as soon as our team confirms them'}{w.summary ? <> — <span className="text-fg-2">{w.summary}</span></> : ''}. No payment was required.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {delivered && <Link href="/app/leads" className="inline-flex h-9 items-center gap-1.5 rounded-md bg-fg px-4 text-[13px] font-medium text-inverse hover:bg-fg-2">View my leads <ArrowRight className="size-3.5" /></Link>}
          <Link href="/app/marketplace" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border-strong px-4 text-[13px] font-medium hover:bg-surface-3"><Sparkles className="size-3.5" />Find more</Link>
        </div>
      </div>
    </div>
  );
}
