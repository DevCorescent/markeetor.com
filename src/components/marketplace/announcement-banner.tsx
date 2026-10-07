'use client';
import { ArrowRight, Megaphone, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fmtAgo } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';

type A = { id: string; kind: string; title: string; body: string | null; link: string | null; createdAt: string };
const KEY = 'lcrm.announcements.dismissed';

/** Recent platform announcements on the client dashboard. Dismissals are remembered on this device. */
export function AnnouncementBanner() {
  const { data } = useApiQuery<{ announcements: A[] }>('/api/v1/announcements/feed', { refetchInterval: 120_000 });
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => { try { setDismissed(JSON.parse(localStorage.getItem(KEY) ?? '[]')); } catch {} }, []);
  const dismiss = (id: string) => {
    const next = [...dismissed, id].slice(-50);
    setDismissed(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  };
  const list = (data?.announcements ?? []).filter((a) => !dismissed.includes(a.id)).slice(0, 2);
  if (!list.length) return null;
  return (
    <div className="mb-4 flex flex-col gap-2">
      {list.map((a) => {
        const Icon = a.kind === 'NEW_LEADS' ? Sparkles : Megaphone;
        return (
          <div key={a.id} className="flex flex-wrap items-start gap-3 rounded-lg sm:flex-nowrap border border-fg/80 bg-surface px-4 py-3 shadow-[var(--raised-shadow)] animate-fade-in">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-fg text-inverse"><Icon className="size-4" /></span>
            <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-5.5rem)]">
              <div className="flex flex-wrap items-baseline gap-x-2"><span className="text-[13.5px] font-medium">{a.title}</span><span className="text-[11px] text-subtle">{fmtAgo(a.createdAt)}</span></div>
              {a.body && <p className="mt-0.5 text-[12.5px] text-muted">{a.body}</p>}
            </div>
            {a.link && <Link href={a.link} className="flex shrink-0 items-center gap-1 self-center max-sm:order-last max-sm:ml-11 max-sm:self-start rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-inverse hover:bg-fg-2">{a.kind === 'NEW_LEADS' ? 'Browse leads' : 'Open'} <ArrowRight className="size-3.5" /></Link>}
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(a.id)} className="rounded p-1 text-subtle hover:text-fg max-sm:-mr-1"><X className="size-3.5" /></button>
          </div>
        );
      })}
    </div>
  );
}
