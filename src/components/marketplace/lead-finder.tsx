'use client';
import { ArrowRight, ArrowUp, Bot, ExternalLink, HelpCircle, Loader2, Lock, RotateCcw, Sparkles, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtInt } from '@/lib/format';
import { money } from '@/lib/pricing';
import { RequestDialog, type MarketSelection } from './request-dialog';

type Action = { type: string; [k: string]: unknown };
type Quick = { label: string; action?: Action; message?: string };
type Row = { id: string; ref: string; industry: string | null; country: string | null; state: string | null; score: number; priceCents: number; seniority: string | null; fresh: boolean; hasEmail: boolean; hasPhone: boolean };
type Results = {
  total: number; requestable: number; filter: { conditions: unknown[] }; avgScore: number;
  breakdown: { industries: { label: string; count: number }[]; countries: { label: string; count: number }[] };
  priceRange: { min: number; max: number } | null;
  estimate: { count: number; totalCents: number; freeApplied: number; currency: string };
  withinBudget: boolean | null; sample: Row[]; relax: { label: string; count: number }[];
};
type Turn = { engine: string; reply: string; criteria: Record<string, unknown>; chips: string[]; quickReplies: Quick[]; faq: readonly { id: string; q: string }[]; results: Results | null };
type Msg = { role: 'user' | 'assistant'; text: string; turn?: Turn };

export const OPEN_EVENT = 'lead-finder:open';
/** Opens the Lead Finder from anywhere (optionally with a first message or FAQ). */
export function openLeadFinder(detail: { message?: string; faq?: string } = {}) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
}

/** Minimal, safe formatting for assistant replies: **bold** and line breaks. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) => (part.startsWith('**') && part.endsWith('**') ? <b key={j} className="font-semibold">{part.slice(2, -2)}</b> : <Fragment key={j}>{part}</Fragment>))}
        </Fragment>
      ))}
    </>
  );
}

export function LeadFinderLauncher({ canRequest }: { canRequest: boolean }) {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<{ message?: string; faq?: string } | null>(null);
  useEffect(() => {
    const h = (e: Event) => { setSeed((e as CustomEvent).detail ?? {}); setOpen(true); };
    window.addEventListener(OPEN_EVENT, h);
    return () => window.removeEventListener(OPEN_EVENT, h);
  }, []);
  return (
    <>
      {!open && (
        <button type="button" onClick={() => { setSeed({}); setOpen(true); }} aria-label="Open Lead Finder"
          className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 flex items-center gap-2 rounded-full bg-fg p-2.5 text-[13px] sm:right-5 sm:bottom-5 sm:py-2.5 sm:pr-4 sm:pl-3 font-medium text-inverse shadow-[var(--raised-shadow)] ring-1 ring-black/10 transition-transform hover:-translate-y-0.5">
          <span className="grid size-7 place-items-center rounded-full bg-inverse/15 sm:size-6"><Sparkles className="size-4 sm:size-3.5" /></span><span className="max-sm:sr-only">Lead Finder</span>
        </button>
      )}
      {open && <FinderPanel seed={seed} canRequest={canRequest} onClose={() => setOpen(false)} />}
    </>
  );
}

function FinderPanel({ seed, canRequest, onClose }: { seed: { message?: string; faq?: string } | null; canRequest: boolean; onClose: () => void }) {
  const router = useRouter();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [criteria, setCriteria] = useState<Record<string, unknown> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [faq, setFaq] = useState<readonly { id: string; q: string }[]>([]);
  const [engine, setEngine] = useState('built-in');
  const [requesting, setRequesting] = useState<MarketSelection | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const send = async (body: { message?: string; action?: Action }, userText?: string) => {
    if (busy) return;
    const history = msgs.slice(-12).map((m) => ({ role: m.role, text: m.text.slice(0, 1800) }));
    if (userText) setMsgs((m) => [...m, { role: 'user', text: userText }]);
    setBusy(true);
    try {
      const t = await api<Turn>('/api/v1/marketplace/finder', { body: { message: body.message ?? null, action: body.action ?? null, criteria, history } });
      setCriteria(t.criteria);
      setFaq(t.faq);
      setEngine(t.engine);
      setMsgs((m) => [...m, { role: 'assistant', text: t.reply, turn: t }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', text: `Sorry — ${errorMessage(e)}` }]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      await send({ action: { type: 'start' } });
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A seed message/FAQ from the dashboard card is sent once the greeting has arrived.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !msgs.length || busy || !seed) return;
    seeded.current = true;
    if (seed.message) void send({ message: seed.message }, seed.message);
    else if (seed.faq) void send({ action: { type: 'faq', id: seed.faq } }, faq.find((f) => f.id === seed.faq)?.q ?? 'Question');
  }, [msgs.length, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); }, [msgs, busy]);

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    void send({ message: text }, text);
  };
  const pick = (q: Quick) => {
    if (q.message) void send({ message: q.message }, q.message);
    else if (q.action) void send({ action: q.action }, q.label.replace(/ · \d+$/, ''));
  };
  const last = [...msgs].reverse().find((m) => m.turn)?.turn;
  const chips = last?.chips ?? [];

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] border-l border-border-strong bg-surface shadow-2xl shadow-shade animate-slide-in sm:w-[440px]" role="dialog" aria-label="Lead Finder">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="grid size-9 place-items-center rounded-xl bg-fg text-inverse"><Sparkles className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold tracking-[-0.01em]">Lead Finder</div>
          <div className="text-[11px] text-subtle">{engine === 'claude' ? 'AI assistant · powered by Claude' : 'Smart assistant'} · finds the right prospects for you</div>
        </div>
        <Button size="icon" variant="ghost" aria-label="Start over" onClick={() => void send({ action: { type: 'reset' } }, 'Start over')}><RotateCcw /></Button>
        <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}><X /></Button>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface-2 px-4 py-2">
          <span className="text-[10.5px] tracking-[0.08em] text-subtle uppercase">Looking for</span>
          {chips.map((c) => <Badge key={c} tone="outline">{c}</Badge>)}
        </div>
      )}

      <div ref={scroller} className="flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-3">
          {msgs.map((m, i) => (
            <div key={i} className={cn('flex flex-col gap-2', m.role === 'user' ? 'items-end' : 'items-start')}>
              {m.role === 'assistant' ? (
                <div className="flex max-w-[92%] gap-2">
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-surface-3 text-muted"><Bot className="size-3.5" /></span>
                  <div className="rounded-2xl rounded-tl-sm bg-surface-3 px-3.5 py-2.5 text-[13px] leading-relaxed"><Rich text={m.text} /></div>
                </div>
              ) : (
                <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-fg px-3.5 py-2 text-[13px] text-inverse">{m.text}</div>
              )}
              {m.turn?.results && <ResultsCard r={m.turn.results} canRequest={canRequest} onRequest={(sel) => setRequesting(sel)} onOpen={(filter) => router.push(`/app/marketplace?filter=${encodeURIComponent(JSON.stringify(filter))}`)} />}
              {m.turn && i === msgs.length - 1 && m.turn.quickReplies.length > 0 && (
                <div className="ml-8 flex flex-wrap gap-1.5">
                  {m.turn.quickReplies.map((q, j) => (
                    <button key={j} type="button" disabled={busy} onClick={() => pick(q)} className="rounded-full border border-border-strong bg-surface px-3 py-1 text-[12px] text-fg-2 transition-colors hover:border-fg hover:text-fg disabled:opacity-50">{q.label}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2">
              <span className="grid size-6 place-items-center rounded-md bg-surface-3 text-muted"><Bot className="size-3.5" /></span>
              <span className="flex gap-1 rounded-2xl bg-surface-3 px-3.5 py-3">{[0, 1, 2].map((d) => <span key={d} className="size-1.5 animate-bounce rounded-full bg-subtle" style={{ animationDelay: `${d * 120}ms` }} />)}</span>
            </div>
          )}
          {msgs.length <= 1 && faq.length > 0 && !busy && (
            <div className="mt-2 rounded-xl border border-border p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-[0.08em] text-subtle uppercase"><HelpCircle className="size-3.5" />Common questions</div>
              <div className="flex flex-col gap-1">
                {faq.map((f) => <button key={f.id} type="button" onClick={() => void send({ action: { type: 'faq', id: f.id } }, f.q)} className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-[12.5px] text-muted hover:bg-surface-3 hover:text-fg">{f.q}<ArrowRight className="size-3.5 opacity-50" /></button>)}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-xl border border-border-strong bg-surface-2 p-1.5 focus-within:border-fg/50">
          <textarea
            value={input} onChange={(e) => setInput(e.target.value)} rows={1} maxLength={1000}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder="e.g. 50 decision-makers in real estate in the US with phones"
            className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-[13px] outline-none placeholder:text-subtle" aria-label="Message"
          />
          <Button size="icon" variant="primary" className="size-9 rounded-lg" disabled={!input.trim() || busy} onClick={submit} aria-label="Send">{busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}</Button>
        </div>
        <div className="mt-1.5 flex items-center gap-1 px-1 text-[10.5px] text-subtle"><Lock className="size-3" />Searches only show non-identifying details. Contact info unlocks after delivery.</div>
      </div>

      <RequestDialog selection={requesting} onClose={() => setRequesting(null)} onDone={(r) => {
        setRequesting(null);
        setMsgs((m) => [...m, { role: 'assistant', text: r.status === 'FULFILLED' || r.status === 'PARTIAL' ? `Done — **${fmtInt(r.deliveredCount)} leads** are now in My leads (${r.code}).` : `Request **${r.code}** sent. I’ll notify you when it’s approved.` }]);
        if (r.status === 'FULFILLED' || r.status === 'PARTIAL') toast.success('Leads delivered', { action: { label: 'View', onClick: () => router.push('/app/leads?view=unassigned') } });
      }} />
    </div>
  );
}

function ResultsCard({ r, canRequest, onRequest, onOpen }: { r: Results; canRequest: boolean; onRequest: (s: MarketSelection) => void; onOpen: (f: { conditions: unknown[] }) => void }) {
  if (!r.total) return null;
  const max = Math.max(1, ...r.breakdown.industries.map((x) => x.count), ...r.breakdown.countries.map((x) => x.count));
  const cur = r.estimate.currency;
  return (
    <div className="ml-8 w-[calc(100%-2rem)] overflow-hidden rounded-xl border border-border-strong bg-surface shadow-[var(--card-shadow)]">
      <div className="flex items-baseline justify-between gap-2 border-b border-border px-3.5 py-2.5">
        <span className="text-[12px] text-muted"><b className="tnum text-[17px] font-semibold text-fg">{fmtInt(r.total)}</b> matching leads</span>
        <span className="text-[11px] text-subtle">avg score {r.avgScore}{r.priceRange ? ` · ${money(r.priceRange.min, cur)}${r.priceRange.max !== r.priceRange.min ? `–${money(r.priceRange.max, cur)}` : ''} each` : ''}</span>
      </div>
      {(r.breakdown.industries.length > 1 || r.breakdown.countries.length > 1) && (
        <div className="grid grid-cols-2 gap-3 border-b border-border px-3.5 py-2.5">
          {(['industries', 'countries'] as const).map((k) => (
            <div key={k}>
              {r.breakdown[k].slice(0, 3).map((x) => (
                <div key={x.label} className="mb-1">
                  <div className="flex justify-between text-[10.5px]"><span className="truncate text-muted">{x.label}</span><span className="tnum">{x.count}</span></div>
                  <div className="h-1 rounded-full bg-surface-3"><div className="h-full rounded-full bg-fg/70" style={{ width: `${(x.count / max) * 100}%` }} /></div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <ul className="divide-y divide-border">
        {r.sample.slice(0, 5).map((l) => (
          <li key={l.id} className="flex items-center gap-2.5 px-3.5 py-2 text-[12px]">
            <Lock className="size-3 shrink-0 text-subtle" />
            <span className="min-w-0 flex-1 truncate"><span className="font-mono text-[11px]">{l.ref}</span><span className="text-muted"> · {[l.industry, l.state ?? l.country].filter(Boolean).join(' · ')}</span>{l.seniority && <span className="text-subtle"> · {l.seniority}</span>}</span>
            <span className="tnum text-[11px] text-subtle">{l.score}</span>
            <span className="tnum font-medium">{money(l.priceCents, cur)}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 border-t border-border bg-surface-2 px-3.5 py-2.5">
        <div className="text-[11.5px] text-muted">{fmtInt(r.estimate.count)} lead{r.estimate.count === 1 ? '' : 's'} ≈ <b className="font-medium text-fg">{money(r.estimate.totalCents, cur)}</b>{r.estimate.freeApplied > 0 && ` · ${r.estimate.freeApplied} free demo lead${r.estimate.freeApplied === 1 ? '' : 's'} included`}{r.withinBudget === false && <span className="text-warn"> · over budget</span>}</div>
        <div className="flex gap-2">
          {canRequest && <Button size="sm" variant="primary" className="flex-1" onClick={() => onRequest({ mode: 'filter', filter: r.filter, excludeIds: [], limit: r.estimate.count })}>Request {fmtInt(r.estimate.count)} lead{r.estimate.count === 1 ? '' : 's'}</Button>}
          <Button size="sm" variant="outline" onClick={() => onOpen(r.filter)}><ExternalLink /> Browse all</Button>
        </div>
      </div>
    </div>
  );
}

/** Dashboard entry point: a prompt box with starter questions that opens the Lead Finder. */
export function LeadFinderCard() {
  const [q, setQ] = useState('');
  const starters = ['Help me find the right leads', 'Leads with phone numbers', 'Fresh leads added this week'];
  const faqs = [['free', 'How do free demo leads work?'], ['pricing', 'How is pricing calculated?'], ['visibility', 'What can I see before requesting?']] as const;
  return (
    <div className="relative overflow-hidden rounded-lg border border-border-strong bg-surface p-5 shadow-[var(--card-shadow)]">
      <div className="pointer-events-none absolute -top-16 -right-16 size-48 rounded-full bg-fg/[0.04]" aria-hidden />
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-xl bg-fg text-inverse"><Sparkles className="size-4" /></span>
        <div><div className="text-[15px] font-semibold tracking-[-0.015em]">Lead Finder</div><div className="text-[12px] text-subtle">Describe your ideal prospects — I’ll ask a few questions and find matching leads.</div></div>
      </div>
      <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { openLeadFinder({ message: q.trim() }); setQ(''); } }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Insurance decision-makers in Canada, score above 70" className="h-10 flex-1 rounded-lg border border-border-strong bg-surface-2 px-3 text-[13px] outline-none placeholder:text-subtle focus:border-fg/50" aria-label="Describe the leads you need" />
        <Button type="submit" variant="primary" className="h-10 px-4">Find leads <ArrowRight /></Button>
      </form>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {starters.map((s) => <button key={s} type="button" onClick={() => openLeadFinder({ message: s })} className="rounded-full border border-border-strong px-3 py-1 text-[12px] text-muted hover:border-fg hover:text-fg">{s}</button>)}
        {faqs.map(([id, label]) => <button key={id} type="button" onClick={() => openLeadFinder({ faq: id })} className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] text-subtle hover:text-fg"><HelpCircle className="size-3" />{label}</button>)}
      </div>
    </div>
  );
}

