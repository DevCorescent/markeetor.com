'use client';
import { Command } from 'cmdk';
import { Building2, Database, Loader2, Search, User } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Dialog as D } from 'radix-ui';
import { api } from '@/lib/api-client';

type Hit = { type: 'lead' | 'org' | 'user'; id: string; title: string; subtitle?: string; href: string };
const ICON = { lead: Database, org: Building2, user: User };

export function GlobalSearch({ placeholder }: { placeholder: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api<{ results: Hit[] }>(`/api/v1/search?q=${encodeURIComponent(q.trim())}`, { signal: ctl.signal });
        setHits(res.results);
      } catch {
        /* aborted or failed — keep previous results */
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex h-9 w-full max-w-[380px] items-center sm:h-8 gap-2 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-subtle transition-colors hover:border-border-strong hover:text-muted"
      >
        <Search className="size-3.5" />
        <span className="flex-1 truncate text-left">{placeholder}</span>
        <kbd className="hidden rounded border border-border-strong px-1 font-mono text-[10px] sm:inline">⌘K</kbd>
      </button>
      <D.Root open={open} onOpenChange={setOpen}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-50 bg-overlay animate-fade-in" />
          <D.Content className="fixed left-1/2 top-[max(0.5rem,env(safe-area-inset-top))] z-50 w-[calc(100vw-1rem)] max-w-xl sm:top-[12vh] sm:w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-lg border border-border-strong bg-surface shadow-2xl animate-pop">
            <D.Title className="sr-only">Search</D.Title>
            <D.Description className="sr-only">Search records you have access to</D.Description>
            <Command shouldFilter={false} label="Global search">
              <div className="flex items-center gap-2 border-b border-border px-3">
                <Search className="size-4 text-subtle" />
                <Command.Input value={q} onValueChange={setQ} placeholder={placeholder} className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" />
                {loading && <Loader2 className="size-4 animate-spin text-subtle" />}
              </div>
              <Command.List className="max-h-[60dvh] sm:max-h-[50vh] overflow-y-auto p-1.5">
                <Command.Empty className="px-3 py-8 text-center text-xs text-subtle">{q.trim().length < 2 ? 'Type at least two characters' : loading ? 'Searching…' : 'No matches'}</Command.Empty>
                {hits.map((h) => {
                  const Icon = ICON[h.type];
                  return (
                    <Command.Item
                      key={`${h.type}:${h.id}`}
                      value={`${h.type}:${h.id}`}
                      onSelect={() => {
                        setOpen(false);
                        router.push(h.href);
                      }}
                      className="flex cursor-pointer items-center gap-3 rounded px-2.5 py-2 text-[13px] data-[selected=true]:bg-surface-3"
                    >
                      <Icon className="size-3.5 text-subtle" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{h.title}</span>
                        {h.subtitle && <span className="block truncate text-[11px] text-subtle">{h.subtitle}</span>}
                      </span>
                      <span className="text-[10px] uppercase tracking-wider text-subtle">{h.type}</span>
                    </Command.Item>
                  );
                })}
              </Command.List>
            </Command>
          </D.Content>
        </D.Portal>
      </D.Root>
    </>
  );
}
