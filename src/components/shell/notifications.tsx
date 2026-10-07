'use client';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { fmtAgo } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/overlay';

type N = { id: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string };

export function Notifications() {
  const [items, setItems] = useState<N[]>([]);
  const [unread, setUnread] = useState(0);
  const load = useCallback(async () => {
    try {
      const res = await api<{ items: N[]; unread: number }>('/api/v1/notifications?pageSize=15');
      setItems(res.items);
      setUnread(res.unread);
    } catch {}
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const markAll = async () => {
    await api('/api/v1/notifications', { method: 'PATCH', body: { all: true } }).catch(() => null);
    load();
  };

  return (
    <Popover onOpenChange={(o) => o && load()}>
      <PopoverTrigger asChild>
        <button className="relative grid size-9 place-items-center sm:size-8 rounded-md text-muted hover:bg-surface-3 hover:text-fg" aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}>
          <Bell className="size-4" />
          {unread > 0 && <span className="tnum absolute top-1 right-1 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-fg px-0.5 text-[9px] font-semibold text-inverse">{unread > 9 ? '9+' : unread}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-[13px] font-medium">Notifications</span>
          {unread > 0 && <button onClick={markAll} className="text-[11.5px] text-subtle hover:text-fg">Mark all read</button>}
        </div>
        <ul className="max-h-[min(420px,70dvh)] overflow-y-auto">
          {items.length === 0 && <li className="px-3 py-10 text-center text-xs text-subtle">You’re all caught up</li>}
          {items.map((n) => {
            const inner = (
              <div className="flex gap-2.5 px-3 py-2.5">
                <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-fg')} aria-hidden />
                <div className="min-w-0">
                  <div className={cn('text-[12.5px]', n.readAt ? 'text-muted' : 'text-fg')}>{n.title}</div>
                  {n.body && <div className="mt-0.5 line-clamp-2 text-[11.5px] text-subtle">{n.body}</div>}
                  <div className="mt-0.5 text-[10.5px] text-subtle">{fmtAgo(n.createdAt)}</div>
                </div>
              </div>
            );
            return (
              <li key={n.id} className="border-b border-border/60 last:border-0 hover:bg-surface-3">
                {n.link ? (
                  <Link href={n.link} onClick={() => api('/api/v1/notifications', { method: 'PATCH', body: { ids: [n.id] } }).then(load).catch(() => null)}>{inner}</Link>
                ) : inner}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
