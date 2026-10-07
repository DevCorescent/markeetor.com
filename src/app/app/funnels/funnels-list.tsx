'use client';
import { ArrowRight, Filter, Megaphone, Plus, Sparkles, TrendingDown, Zap } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { MiniFunnel, type FunnelAnalysis } from '@/components/funnels/funnel-chart';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtInt, fmtPct } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';

type Stage = { id: string; name: string; conditions: unknown[]; automation?: { enabled: boolean } | null };
type FunnelRow = { id: string; name: string; description: string | null; goal: string | null; status: string; stages: Stage[]; updatedAt: string; campaignCount: number; analysis: FunnelAnalysis };
type Template = { key: string; name: string; description: string; goal: string; stages: Stage[]; baseFilter?: { conditions: unknown[] } };

export function FunnelsList({ canManage }: { canManage: boolean }) {
  const { data, isLoading } = useApiQuery<{ funnels: FunnelRow[] }>('/api/v1/crm/funnels');
  const [creating, setCreating] = useState(false);
  const funnels = data?.funnels ?? [];
  const leadsInFunnels = funnels.reduce((n, f) => n + (f.analysis.stages[0]?.reached ?? 0), 0);
  const automations = funnels.reduce((n, f) => n + f.stages.filter((s) => s.automation?.enabled).length, 0);
  return (
    <>
      <PageHeader title="Funnels" description="Map how your leads move from first touch to closed deal, spot where they drop off, and launch campaigns at exactly the right stage."
        actions={canManage && <Button variant="primary" onClick={() => setCreating(true)}><Plus /> New funnel</Button>} />
      {isLoading ? <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-64" />)}</div> : !funnels.length ? (
        <Card className="relative overflow-hidden">
          <div className="grid grid-cols-1 items-center gap-8 px-8 py-12 md:grid-cols-[1fr_280px]">
            <div>
              <div className="eyebrow mb-2">Get started</div>
              <h2 className="text-[20px] font-[560] tracking-[-0.02em]">Build your first funnel in under a minute</h2>
              <p className="mt-2 max-w-lg text-[13px] text-muted">Pick a proven template — sales pipeline, engagement, nurture — and it is filled with your leads instantly. Then send emails, create follow-up tasks or switch on automations for any stage.</p>
              <div className="mt-5 flex flex-wrap gap-4 text-[12px] text-fg-2">
                <span className="flex items-center gap-1.5"><TrendingDown className="size-3.5" />Drop-off analysis</span>
                <span className="flex items-center gap-1.5"><Megaphone className="size-3.5" />Stage campaigns</span>
                <span className="flex items-center gap-1.5"><Zap className="size-3.5" />Automations</span>
              </div>
              {canManage && <Button className="mt-6" variant="primary" onClick={() => setCreating(true)}><Sparkles /> Choose a template</Button>}
            </div>
            <div className="hidden md:block"><MiniFunnel analysis={{ total: 100, overallConversion: 0.1, bottleneck: null, stages: [100, 64, 38, 21, 10].map((r, i) => ({ id: String(i), name: '', reached: r, current: 0, value: 0, avgScore: 0, conversion: 0, dropOff: 0 })) }} /></div>
          </div>
        </Card>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-3 gap-3">
            <Stat label="Active funnels" value={fmtInt(funnels.filter((f) => f.status === 'ACTIVE').length)} />
            <Stat label="Leads tracked" value={fmtInt(leadsInFunnels)} />
            <Stat label="Automations running" value={fmtInt(automations)} />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {funnels.map((f) => <FunnelCard key={f.id} f={f} />)}
            {canManage && (
              <button type="button" onClick={() => setCreating(true)} className="flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong text-[13px] text-muted transition-colors hover:border-fg hover:text-fg">
                <Plus className="size-5" />New funnel
              </button>
            )}
          </div>
        </>
      )}
      {creating && <NewFunnelDialog onClose={() => setCreating(false)} />}
    </>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => <Card className="px-4 py-3.5"><div className="eyebrow">{label}</div><div className="tnum mt-2 text-[22px] leading-none font-[520] tracking-[-0.03em]">{value}</div></Card>;

function FunnelCard({ f }: { f: FunnelRow }) {
  const a = f.analysis;
  const bn = a.bottleneck ? a.stages.find((s) => s.id === a.bottleneck!.id) : null;
  return (
    <Link href={`/app/funnels/${f.id}`} className="group">
      <Card className="flex h-full flex-col transition-colors group-hover:border-fg/40">
        <div className="flex items-start justify-between gap-2 px-4 pt-4">
          <div className="min-w-0"><div className="truncate text-[14px] font-medium">{f.name}</div><div className="truncate text-[12px] text-subtle">{f.goal || f.description || `${f.stages.length} stages`}</div></div>
          <Badge tone={f.status === 'ACTIVE' ? 'ok' : 'dim'} dot>{f.status === 'ACTIVE' ? 'Active' : 'Paused'}</Badge>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-4">
          <MiniFunnel analysis={a} />
          <div className="text-right"><div className="tnum text-[26px] leading-none font-[560] tracking-[-0.03em]">{fmtPct(a.overallConversion, 1)}</div><div className="mt-1 text-[11px] text-subtle">end-to-end</div></div>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-4 text-[11.5px] text-muted">
          {a.stages.slice(0, 4).map((s) => <span key={s.id} className="tnum">{s.name} <b className="font-medium text-fg">{fmtInt(s.reached)}</b></span>)}
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 pt-2.5 text-[11.5px] text-subtle" style={{ marginTop: 'auto' }}>
          <span className={cn('truncate', bn && 'text-warn')}>{bn ? `Biggest drop after “${bn.name}” (${fmtPct(a.bottleneck!.rate, 0)})` : `${f.campaignCount} campaign${f.campaignCount === 1 ? '' : 's'} · ${fmtAgo(f.updatedAt)}`}</span>
          <ArrowRight className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
        </div>
      </Card>
    </Link>
  );
}

function NewFunnelDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { data } = useApiQuery<{ templates: Template[] }>('/api/v1/crm/funnels/templates');
  const [pick, setPick] = useState<string>('sales');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const tpl = data?.templates.find((t) => t.key === pick);
  const create = async () => {
    const blank = pick === 'blank';
    const stages = blank
      ? [{ id: `s${Date.now().toString(36)}a`, name: 'All leads', conditions: [] }, { id: `s${Date.now().toString(36)}b`, name: 'Converted', conditions: [{ field: 'status', op: 'in', value: ['CONVERTED'] }] }]
      : tpl?.stages;
    if (!stages) return;
    setBusy(true);
    try {
      const f = await api<{ id: string }>('/api/v1/crm/funnels', { body: { name: name.trim() || (blank ? 'New funnel' : tpl!.name), description: blank ? null : tpl!.description, goal: blank ? null : tpl!.goal, status: 'ACTIVE', baseFilter: tpl?.baseFilter && !blank ? tpl.baseFilter : { conditions: [] }, stages } });
      router.push(`/app/funnels/${f.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New funnel" description="Start from a template — every stage is already wired to your lead data. You can change anything afterwards." size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={create}>Create funnel <ArrowRight /></Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(data?.templates ?? []).map((t) => (
            <button key={t.key} type="button" onClick={() => setPick(t.key)} className={cn('flex flex-col gap-2 rounded-lg border px-3.5 py-3 text-left transition-colors', pick === t.key ? 'border-fg ring-1 ring-fg' : 'border-border-strong hover:border-fg/50')}>
              <div className="flex items-center justify-between gap-2"><span className="text-[13px] font-medium">{t.name}</span><span className="text-[10.5px] text-subtle">{t.stages.length} stages</span></div>
              <p className="text-[11.5px] leading-snug text-muted">{t.description}</p>
              <div className="flex flex-wrap items-center gap-1 text-[10.5px] text-subtle">{t.stages.map((s, i) => <span key={s.id} className="flex items-center gap-1">{i > 0 && <ArrowRight className="size-2.5" />}{s.name}</span>)}</div>
            </button>
          ))}
          <button type="button" onClick={() => setPick('blank')} className={cn('flex flex-col justify-center gap-1 rounded-lg border border-dashed px-3.5 py-3 text-left', pick === 'blank' ? 'border-fg ring-1 ring-fg' : 'border-border-strong hover:border-fg/50')}>
            <span className="flex items-center gap-1.5 text-[13px] font-medium"><Filter className="size-3.5" />Blank funnel</span>
            <span className="text-[11.5px] text-muted">Two stages to start; define your own conditions.</span>
          </button>
          {!data && [0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={pick === 'blank' ? 'New funnel' : tpl?.name} /></Field>
      </div>
    </Dialog>
  );
}
