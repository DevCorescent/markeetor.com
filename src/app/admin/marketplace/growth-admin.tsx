'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Bookmark, Check, Gift, Mail, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, Switch } from '@/components/ui/overlay';
import { Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtDateTime, fmtInt } from '@/lib/format';
import { DISPUTE_REASONS, type GrowthSettings } from '@/lib/growth';
import { useApiQuery } from '@/lib/hooks';
import { money } from '@/lib/pricing';

type Dispute = {
  id: string; code: string; status: string; reason: string; reasonLabel: string; details: string | null; paidAmount: number; paidCredits: number; refundCredits: number;
  resolution: string | null; autoDecided: boolean; createdAt: string; decidedAt: string | null; organization?: string | null; reporter: string | null; request: string | null;
  lead?: { fullName: string; company: string | null; email: string | null; phone: string | null } | null;
};

/** Lead quality guarantee queue: approve (refund credits) or reject client reports. */
export function DisputesAdmin({ currency }: { currency: string }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('OPEN');
  const { data } = useApiQuery<{ total: number; open: number; rows: Dispute[] }>(`/api/v1/disputes?page=1&pageSize=50${status ? `&status=${status}` : ''}`, { refetchInterval: 30_000 });
  const [open, setOpen] = useState<Dispute | null>(null);
  const [approve, setApprove] = useState(true);
  const [resolution, setResolution] = useState('');
  const [refund, setRefund] = useState('');
  const [busy, setBusy] = useState(false);
  const start = (d: Dispute, ok: boolean) => { setOpen(d); setApprove(ok); setResolution(ok ? 'Confirmed — refunded under the lead quality guarantee' : ''); setRefund(String(d.refundCredits)); };
  const decide = async () => {
    if (!open) return;
    setBusy(true);
    try {
      await api(`/api/v1/disputes/${open.id}/decide`, { body: { approve, resolution, ...(approve ? { refundCredits: Math.max(0, Math.round(Number(refund) || 0)) } : {}) } });
      toast.success(approve ? 'Approved — credits refunded' : 'Report rejected');
      await qc.invalidateQueries({ predicate: (q) => /\/disputes|\/credits/.test(String(q.queryKey[0] ?? '')) });
      setOpen(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><ShieldCheck className="size-4 text-ok" />Lead quality reports</span>} description="Clients report bad leads within the guarantee window. Approving refunds credits and, for contact problems, retires the lead."
        actions={<Select className="h-8 w-36 text-[12px]" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="OPEN">Open ({data?.open ?? 0})</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="">All</option></Select>} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-[12.5px]">
          <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">{['Report', 'Client', 'Lead', 'Reason', 'Paid', 'Refund', 'Status', ''].map((h, i) => <th key={i} className="h-9 px-4 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {(data?.rows ?? []).map((d) => (
              <tr key={d.id} className="border-b border-border/60 align-top last:border-0">
                <td className="px-4 py-2.5"><div className="font-mono text-[12px]">{d.code}</div><div className="text-[11px] text-subtle">{fmtAgo(d.createdAt)}{d.request ? ` · ${d.request}` : ''}</div></td>
                <td className="px-4 py-2.5"><div>{d.organization}</div><div className="text-[11px] text-subtle">{d.reporter}</div></td>
                <td className="px-4 py-2.5"><div>{d.lead?.fullName ?? '—'}</div><div className="text-[11px] text-subtle">{[d.lead?.company, d.lead?.phone, d.lead?.email].filter(Boolean).join(' · ')}</div></td>
                <td className="max-w-[240px] px-4 py-2.5"><div className="font-medium">{d.reasonLabel}</div>{d.details && <div className="text-[11.5px] text-muted">{d.details}</div>}</td>
                <td className="tnum px-4 py-2.5">{d.paidCredits ? `${fmtInt(d.paidCredits)} cr` : money(Math.round(d.paidAmount * 100), currency)}</td>
                <td className="tnum px-4 py-2.5 font-medium">{fmtInt(d.refundCredits)} cr</td>
                <td className="px-4 py-2.5"><StatusBadge status={d.status === 'OPEN' ? 'PENDING' : d.status} />{d.autoDecided && <div className="text-[10.5px] text-subtle">automatic</div>}{d.resolution && d.status !== 'OPEN' && <div className="max-w-[180px] text-[11px] text-subtle">{d.resolution}</div>}</td>
                <td className="px-4 py-2.5 text-right">{d.status === 'OPEN' && <div className="flex justify-end gap-1.5"><Button size="xs" variant="ghost" onClick={() => start(d, false)}><X /> Reject</Button><Button size="xs" variant="primary" onClick={() => start(d, true)}><Check /> Approve</Button></div>}</td>
              </tr>
            ))}
            {!data ? <tr><td colSpan={8} className="p-4"><Skeleton className="h-16" /></td></tr> : !data.rows.length && <tr><td colSpan={8} className="py-10 text-center text-subtle">No {status ? status.toLowerCase() : ''} reports.</td></tr>}
          </tbody>
        </table>
      </div>
      <Dialog open={Boolean(open)} onOpenChange={(o) => !o && setOpen(null)} title={approve ? `Approve ${open?.code}` : `Reject ${open?.code}`} description={approve ? 'Credits are added to the client’s wallet and they are notified.' : 'The client is notified with your reason. Nothing is refunded.'}
        footer={<><Button variant="ghost" onClick={() => setOpen(null)}>Cancel</Button><Button variant={approve ? 'primary' : 'danger'} loading={busy} disabled={resolution.trim().length < 3} onClick={decide}>{approve ? `Approve & refund ${fmtInt(Number(refund) || 0)} credits` : 'Reject'}</Button></>}>
        <div className="flex flex-col gap-3">
          {approve && <Field label="Credits to refund"><Input type="number" min={0} value={refund} onChange={(e) => setRefund(e.target.value)} /></Field>}
          <Field label={approve ? 'Note to the client' : 'Reason'}><Textarea rows={3} value={resolution} maxLength={500} onChange={(e) => setResolution(e.target.value)} /></Field>
        </div>
      </Dialog>
    </Card>
  );
}

type Refs = { rows: { id: string; referrer: string; referee: string; status: string; createdAt: string; rewardedAt: string | null }[]; rewarded: number; pending: number };

/** Platform rules for saved searches & auto-buy, the guarantee, referrals and weekly reports. */
export function GrowthAdmin() {
  const qc = useQueryClient();
  const { data } = useApiQuery<{ settings: GrowthSettings }>('/api/v1/growth/settings');
  const refs = useApiQuery<Refs>('/api/v1/growth/referrals');
  const [g, setG] = useState<GrowthSettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) setG(data.settings); }, [data]);
  if (!g) return <Skeleton className="h-96" />;
  const dirty = JSON.stringify(g) !== JSON.stringify(data?.settings);
  const save = async () => {
    setSaving(true);
    try {
      await api('/api/v1/growth/settings', { method: 'PUT', body: g });
      toast.success('Growth settings saved');
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/growth') });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));
  const head = (icon: React.ComponentType<{ className?: string }>, tone: string, title: string) => { const I = icon; return <span className="flex items-center gap-2"><span className={cn('grid size-6 place-items-center rounded-md', tone)}><I className="size-3.5" /></span>{title}</span>; };
  return (
    <div className="flex flex-col gap-4 pb-16">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={head(Bookmark, 'bg-info-dim text-info', 'Saved searches & auto-buy')} description="Clients save marketplace filters, get alerts on new matches and can auto-buy them with credits." actions={<Switch checked={g.savedSearches.enabled} onCheckedChange={(v) => setG({ ...g, savedSearches: { ...g.savedSearches, enabled: v } })} aria-label="Saved searches" />} />
          <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Saved searches per workspace"><Input type="number" min={1} max={100} value={g.savedSearches.maxPerWorkspace} onChange={(e) => setG({ ...g, savedSearches: { ...g.savedSearches, maxPerWorkspace: num(e.target.value, 1, 100) } })} /></Field>
            <Field label="Auto-buy cap per search per week"><Input type="number" min={1} max={5000} value={g.savedSearches.maxAutoBuyPerWeek} onChange={(e) => setG({ ...g, savedSearches: { ...g.savedSearches, maxAutoBuyPerWeek: num(e.target.value, 1, 5000) } })} /></Field>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-[12.5px] sm:col-span-2"><span><span className="block font-medium">Allow auto-buy</span><span className="block text-[11.5px] text-subtle">New matches are requested automatically and paid with credits.</span></span><Switch checked={g.savedSearches.autoBuyEnabled} onCheckedChange={(v) => setG({ ...g, savedSearches: { ...g.savedSearches, autoBuyEnabled: v } })} aria-label="Auto-buy" /></label>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={head(ShieldCheck, 'bg-ok-dim text-ok', 'Lead quality guarantee')} description="Clients can report bad purchased leads; approved reports are refunded in credits." actions={<Switch checked={g.guarantee.enabled} onCheckedChange={(v) => setG({ ...g, guarantee: { ...g.guarantee, enabled: v } })} aria-label="Guarantee" />} />
          <CardBody className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Window (days)"><Input type="number" min={1} max={90} value={g.guarantee.windowDays} onChange={(e) => setG({ ...g, guarantee: { ...g.guarantee, windowDays: num(e.target.value, 1, 90) } })} /></Field>
              <Field label="Refund (% of price)"><Input type="number" min={0} max={100} value={g.guarantee.refundPct} onChange={(e) => setG({ ...g, guarantee: { ...g.guarantee, refundPct: num(e.target.value, 0, 100) } })} /></Field>
              <Field label="Max reported (% of 30-day buys)"><Input type="number" min={1} max={100} value={g.guarantee.maxReportPct} onChange={(e) => setG({ ...g, guarantee: { ...g.guarantee, maxReportPct: num(e.target.value, 1, 100) } })} /></Field>
            </div>
            <Field label="Approve automatically">
              <div className="flex flex-wrap gap-1.5">
                {DISPUTE_REASONS.map((r) => {
                  const on = g.guarantee.autoApproveReasons.includes(r.key);
                  return <button key={r.key} type="button" onClick={() => setG({ ...g, guarantee: { ...g.guarantee, autoApproveReasons: on ? g.guarantee.autoApproveReasons.filter((x) => x !== r.key) : [...g.guarantee.autoApproveReasons, r.key] } })} className={cn('rounded-full border px-2.5 py-1 text-[11.5px]', on ? 'border-ok/40 bg-ok-dim text-ok' : 'border-border text-muted')}>{on && <Check className="mr-1 inline size-3" />}{r.label}</button>;
                })}
              </div>
            </Field>
            <label className="flex items-center justify-between gap-3 text-[12.5px]"><span>Retire leads with approved contact problems (never sold again)</span><Switch checked={g.guarantee.invalidateOnApproval} onCheckedChange={(v) => setG({ ...g, guarantee: { ...g.guarantee, invalidateOnApproval: v } })} aria-label="Retire leads" /></label>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={head(Gift, 'bg-accent-dim text-accent', 'Referrals')} description="Workspaces share a /join link; both sides earn credits after the new workspace’s first paid purchase." actions={<Switch checked={g.referrals.enabled} onCheckedChange={(v) => setG({ ...g, referrals: { ...g.referrals, enabled: v } })} aria-label="Referrals" />} />
          <CardBody className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Credits for the referrer"><Input type="number" min={0} value={g.referrals.referrerCredits} onChange={(e) => setG({ ...g, referrals: { ...g.referrals, referrerCredits: num(e.target.value, 0, 1_000_000) } })} /></Field>
              <Field label="Credits for the new workspace"><Input type="number" min={0} value={g.referrals.refereeCredits} onChange={(e) => setG({ ...g, referrals: { ...g.referrals, refereeCredits: num(e.target.value, 0, 1_000_000) } })} /></Field>
            </div>
            <div className="text-[12px] text-muted">{fmtInt(refs.data?.rewarded ?? 0)} rewarded · {fmtInt(refs.data?.pending ?? 0)} waiting for a first purchase</div>
            {(refs.data?.rows.length ?? 0) > 0 && (
              <ul className="flex max-h-48 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border text-[12px]">
                {refs.data!.rows.map((r) => <li key={r.id} className="flex items-center gap-2 px-3 py-2"><span className="font-medium">{r.referrer}</span><span className="text-subtle">→</span><span>{r.referee}</span><span className={cn('ml-auto', r.status === 'REWARDED' ? 'text-ok' : 'text-subtle')}>{r.status === 'REWARDED' ? `rewarded ${fmtAgo(r.rewardedAt!)}` : `joined ${fmtDateTime(r.createdAt)}`}</span></li>)}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={head(Mail, 'bg-warn-dim text-warn', 'Weekly client report')} description="Every Monday 08:00, workspace admins get last week’s leads, speed-to-lead, wins and return on spend by email." actions={<Switch checked={g.weeklyReport.enabled} onCheckedChange={(v) => setG({ ...g, weeklyReport: { enabled: v } })} aria-label="Weekly report" />} />
        </Card>
      </div>
      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur lg:left-[232px]">
          <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-2.5 md:px-6">
            <span className="text-[12.5px] text-muted">Unsaved growth settings</span>
            <Button variant="ghost" className="ml-auto" onClick={() => setG(data!.settings)}>Discard</Button>
            <Button variant="primary" loading={saving} onClick={save}>Save</Button>
          </div>
        </div>
      )}
    </div>
  );
}
