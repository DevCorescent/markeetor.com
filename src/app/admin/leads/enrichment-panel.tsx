'use client';
import { AlertTriangle, Bot, CheckCircle2, Database, Landmark, ExternalLink, Globe, Loader2, Mail, Phone, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CinInput, CompanyLinks, RegistrationBlock, type Registration } from '@/components/company/registry-view';
import { Badge } from '@/components/ui/badge';
import { companyLinks } from '@/lib/company-registry';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Dialog, Switch } from '@/components/ui/overlay';
import { Kpi, KpiGrid } from '@/components/ui/page';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import type { Selection } from '@/lib/filters';
import { fmtAgo, fmtInt, fmtPct } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';

type Status = 'QUEUED' | 'RUNNING' | 'DONE' | 'PARTIAL' | 'FAILED' | 'SKIPPED';

export function ResearchBadge({ e }: { e: { status: string; confidence: number } | null }) {
  if (!e) return <span className="text-[11.5px] text-faint">—</span>;
  const s = e.status as Status;
  if (s === 'DONE') return <Badge tone="ok"><Sparkles className="size-3" />{e.confidence}%</Badge>;
  if (s === 'PARTIAL') return <Badge tone="neutral">Partial</Badge>;
  if (s === 'FAILED') return <Badge tone="danger">Failed</Badge>;
  if (s === 'RUNNING') return <Badge tone="outline"><Loader2 className="size-3 animate-spin" />Running</Badge>;
  if (s === 'QUEUED') return <Badge tone="outline">Queued</Badge>;
  return <Badge tone="dim">Skipped</Badge>;
}

// ── Bulk dialog ────────────────────────────────────────────────────

export function EnrichDialog({ selection, count, onClose, onDone }: { selection: Selection; count: number; onClose: () => void; onDone: () => void }) {
  const [apply, setApply] = useState<'empty' | 'overwrite' | 'none'>('empty');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ queued: number; skipped: number }>('/api/v1/enrichment/run', { body: { selection, apply, force } });
      toast.success(r.queued ? `Researching ${fmtInt(r.queued)} lead${r.queued === 1 ? '' : 's'}` : 'Nothing to research', { description: r.skipped ? `${fmtInt(r.skipped)} already researched recently were skipped.` : 'Progress appears in the AI research tab.' });
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Research ${fmtInt(count)} lead${count === 1 ? '' : 's'} with AI`} size="md"
      description="Each lead’s company website is read (robots.txt respected), its email domain and phone are verified, and AI builds a sourced company profile."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}><Sparkles /> Start research</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Save results to the lead record">
          <Select value={apply} onChange={(e) => setApply(e.target.value as typeof apply)}>
            <option value="empty">Fill empty fields only (recommended)</option>
            <option value="overwrite">Overwrite company & industry when confident</option>
            <option value="none">Don’t change leads — keep research only</option>
          </Select>
        </Field>
        <label className="flex items-start justify-between gap-3 text-[12.5px]">
          <span>Re-research leads done recently<span className="mt-0.5 block text-[11.5px] text-subtle">Otherwise leads researched within the refresh window are skipped.</span></span>
          <Switch checked={force} onCheckedChange={setForce} aria-label="Force" />
        </label>
        <InlineNotice>Runs in the background. Leads of the same company share one website visit, so large batches finish quickly.</InlineNotice>
      </div>
    </Dialog>
  );
}

// ── Overview tab ───────────────────────────────────────────────────

type Overview = {
  totalLeads: number; counts: Partial<Record<Status, number>>; enriched: number; domainsCached: number;
  batches: { id: string; total: number; done: number; failed: number; pending: number; skipped: number }[];
  failures: { leadId: string; error: string | null; domain: string | null; finishedAt: string | null; lead: { fullName: string } }[];
  engine: 'claude' | 'heuristic'; egress: boolean; webSearch: boolean; webResearch: boolean; registry: { falconebiz: boolean; opencorporates: boolean };
  policy: { autoOnImport: boolean; applyMode: 'empty' | 'overwrite' | 'none'; minConfidence: number; refreshDays: number; maxPerDay: number; clientResearch: boolean; clientDailyLimit: number; webResearch: boolean };
};

export function EnrichmentPanel({ canRun }: { canRun: boolean }) {
  const { data, refetch } = useApiQuery<Overview>('/api/v1/enrichment', { refetchInterval: 5000 });
  const [policy, setPolicy] = useState<Overview['policy'] | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data && !policy) setPolicy(data.policy); }, [data, policy]);
  if (!data || !policy) return <div className="flex flex-col gap-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  const c = data.counts;
  const pending = (c.QUEUED ?? 0) + (c.RUNNING ?? 0);
  const coverage = data.totalLeads ? data.enriched / data.totalLeads : 0;
  const runAll = async () => {
    setBusy(true);
    try {
      const r = await api<{ queued: number; skipped: number }>('/api/v1/enrichment/run', { body: { selection: { mode: 'filter', filter: { conditions: [{ field: 'enrichment', op: 'empty' }] }, excludeIds: [] } } });
      toast.success(r.queued ? `Researching ${fmtInt(r.queued)} leads` : 'Every lead has been researched');
      refetch();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const save = async () => {
    setSaving(true);
    try { await api('/api/v1/enrichment/settings', { method: 'PUT', body: policy }); toast.success('Research settings saved'); refetch(); } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  const cancel = async (id: string) => { try { const r = await api<{ cancelled: number }>(`/api/v1/enrichment/batches/${id}/cancel`, { method: 'POST' }); toast.success(`${fmtInt(r.cancelled)} queued leads cancelled`); refetch(); } catch (e) { toast.error(errorMessage(e)); } };

  return (
    <div className="flex flex-col gap-4">
      <KpiGrid>
        <Kpi label="Coverage" value={fmtPct(coverage, 0)} sub={`${fmtInt(data.enriched)} of ${fmtInt(data.totalLeads)} leads`} />
        <Kpi label="Researched" value={fmtInt(c.DONE ?? 0)} sub={`${fmtInt(c.PARTIAL ?? 0)} partial (no company site)`} />
        <Kpi label="In progress" value={fmtInt(pending)} sub={pending ? 'updating live' : 'idle'} />
        <Kpi label="Failed" value={fmtInt(c.FAILED ?? 0)} sub="retry from the lead or in bulk" />
        <Kpi label="Company sites cached" value={fmtInt(data.domainsCached)} sub="reused for 14 days" />
      </KpiGrid>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Research runs" description="Bulk runs from the last 7 days" actions={canRun && <Button size="sm" variant="primary" loading={busy} onClick={runAll}><Sparkles /> Research all unresearched</Button>} />
            {!data.batches.length ? <div className="px-4 py-10 text-center text-[12.5px] text-subtle">No runs yet. Select leads in the repository and choose “Research with AI”.</div> : (
              <ul className="divide-y divide-border">
                {data.batches.map((b) => {
                  const pct = b.total ? (b.done + b.failed + b.skipped) / b.total : 0;
                  return (
                    <li key={b.id} className="flex items-center gap-4 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2 text-[12.5px]"><span className="font-mono text-[11.5px] text-muted">{b.id}</span><span className="tnum text-muted">{fmtInt(b.done + b.failed + b.skipped)} / {fmtInt(b.total)}</span></div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-fg transition-[width] duration-700" style={{ width: `${Math.max(2, pct * 100)}%` }} /></div>
                        <div className="mt-1.5 flex gap-3 text-[11px] text-subtle"><span>{fmtInt(b.done)} researched</span>{b.failed > 0 && <span className="text-danger">{fmtInt(b.failed)} failed</span>}{b.pending > 0 && <span>{fmtInt(b.pending)} pending</span>}{b.skipped > 0 && <span>{fmtInt(b.skipped)} cancelled</span>}</div>
                      </div>
                      <div className="flex w-[110px] justify-end gap-1">
                        <Link href={`/admin/leads?filter=${encodeURIComponent(JSON.stringify({ conditions: [{ field: 'enrichment', op: 'in', value: ['DONE', 'PARTIAL'] }] }))}`} className="inline-flex h-7 items-center rounded-md px-2 text-[12px] text-muted hover:bg-surface-3 hover:text-fg">View</Link>
                        {b.pending > 0 && canRun && <Button size="xs" variant="ghost" onClick={() => cancel(b.id)}><X /> Stop</Button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          {data.failures.length > 0 && (
            <Card>
              <CardHeader title="Recent failures" />
              <ul className="divide-y divide-border">
                {data.failures.map((f) => (
                  <li key={f.leadId} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
                    <AlertTriangle className="size-3.5 shrink-0 text-warn" />
                    <Link href={`/admin/leads/${f.leadId}`} className="min-w-0 flex-1 truncate hover:underline">{f.lead.fullName}{f.domain ? <span className="text-subtle"> · {f.domain}</span> : null}</Link>
                    <span className="max-w-[45%] truncate text-[11.5px] text-subtle">{f.error}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Engine" />
            <ul className="flex flex-col gap-2.5 px-4 py-3.5 text-[12.5px]">
              <li className="flex items-center gap-2.5"><Bot className="size-4 text-muted" /><span className="flex-1">Profile builder</span>{data.engine === 'claude' ? <Badge tone="ok">Claude AI</Badge> : <Badge tone="neutral">Rules (AI off)</Badge>}</li>
              <li className="flex items-center gap-2.5"><Globe className="size-4 text-muted" /><span className="flex-1">Website reader</span><Badge tone="ok">On · robots.txt respected</Badge></li>
              <li className="flex items-center gap-2.5"><Search className="size-4 text-muted" /><span className="flex-1">Find site by company name</span>{data.webSearch ? <Badge tone="ok">Brave Search</Badge> : <Badge tone="dim">Not configured</Badge>}</li>
              <li className="flex items-center gap-2.5"><Globe className="size-4 text-muted" /><span className="flex-1">Deep web research (Claude web search)</span>{data.webResearch && data.policy.webResearch ? <Badge tone="ok">On</Badge> : data.webResearch ? <Badge tone="dim">Off in settings</Badge> : <Badge tone="warn">Needs AI key</Badge>}</li>
              <li className="flex items-center gap-2.5"><Search className="size-4 text-muted" /><span className="flex-1">Wikidata (notable companies)</span><Badge tone="ok">On</Badge></li>
              <li className="flex items-center gap-2.5"><Landmark className="size-4 text-muted" /><span className="flex-1">Company registry (MCA)</span>{data.registry.falconebiz ? <Badge tone="ok">Falcon eBiz</Badge> : data.registry.opencorporates ? <Badge tone="ok">OpenCorporates</Badge> : <Badge tone="dim">CIN from website only</Badge>}</li>
              <li className="flex items-center gap-2.5"><Database className="size-4 text-muted" /><span className="flex-1">Personal data sent to AI</span>{data.egress ? <Badge tone="warn">Allowed</Badge> : <Badge tone="dim">Company data only</Badge>}</li>
            </ul>
            {data.engine !== 'claude' && <p className="border-t border-border px-4 py-3 text-[11.5px] text-subtle">Turn on AI in Settings → AI (with <span className="font-mono">AI_PROVIDER_API_KEY</span>) for richer, more accurate profiles. Without it, structured data and keyword rules are used.</p>}
            {!data.registry.falconebiz && !data.registry.opencorporates && <p className="border-t border-border px-4 py-3 text-[11.5px] text-subtle">For official MCA records (status, incorporation, capital, activity) by company name, add <span className="font-mono">FALCONEBIZ_API_KEY</span> or <span className="font-mono">OPENCORPORATES_API_TOKEN</span>. ZaubaCorp and Tracxn don’t permit automated access, so they’re offered as links.</p>}
          </Card>
          <Card>
            <CardHeader title="Settings" />
            <div className="flex flex-col gap-3.5 px-4 py-3.5">
              <label className="flex items-start justify-between gap-3 text-[12.5px]"><span>Research new imports automatically<span className="mt-0.5 block text-[11.5px] text-subtle">Every lead added by an import is researched in the background.</span></span><Switch checked={policy.autoOnImport} disabled={!canRun} onCheckedChange={(v) => setPolicy({ ...policy, autoOnImport: v })} aria-label="Auto research" /></label>
              <label className="flex items-start justify-between gap-3 text-[12.5px]"><span>Deep web research with AI<span className="mt-0.5 block text-[11.5px] text-subtle">When a company’s own site isn’t enough, Claude searches the web — registries, directories, news — and records sourced company facts.</span></span><Switch checked={policy.webResearch} disabled={!canRun} onCheckedChange={(v) => setPolicy({ ...policy, webResearch: v })} aria-label="Deep web research" /></label>
              <label className="flex items-start justify-between gap-3 text-[12.5px]"><span>Let clients research companies<span className="mt-0.5 block text-[11.5px] text-subtle">From the marketplace and their leads. Results are saved for everyone — a company is never researched twice.</span></span><Switch checked={policy.clientResearch} disabled={!canRun} onCheckedChange={(v) => setPolicy({ ...policy, clientResearch: v })} aria-label="Client research" /></label>
              {policy.clientResearch && <Field label="Research credits per workspace per day"><Input type="number" min={0} max={10000} value={policy.clientDailyLimit} disabled={!canRun} onChange={(e) => setPolicy({ ...policy, clientDailyLimit: Math.max(0, Math.min(10000, Number(e.target.value))) })} /></Field>}
              <Field label="Save results to leads">
                <Select value={policy.applyMode} disabled={!canRun} onChange={(e) => setPolicy({ ...policy, applyMode: e.target.value as Overview['policy']['applyMode'] })}>
                  <option value="empty">Fill empty fields only</option><option value="overwrite">Overwrite when confident</option><option value="none">Keep research only</option>
                </Select>
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Min. confidence"><Input type="number" min={0} max={100} value={policy.minConfidence} disabled={!canRun} onChange={(e) => setPolicy({ ...policy, minConfidence: Math.max(0, Math.min(100, Number(e.target.value))) })} /></Field>
                <Field label="Refresh (days)"><Input type="number" min={1} max={365} value={policy.refreshDays} disabled={!canRun} onChange={(e) => setPolicy({ ...policy, refreshDays: Math.max(1, Math.min(365, Number(e.target.value))) })} /></Field>
                <Field label="Max per run"><Input type="number" min={10} max={50000} value={policy.maxPerDay} disabled={!canRun} onChange={(e) => setPolicy({ ...policy, maxPerDay: Math.max(10, Math.min(50000, Number(e.target.value))) })} /></Field>
              </div>
              {canRun && <Button size="sm" className="self-end" loading={saving} onClick={save}>Save settings</Button>}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── Lead page card ─────────────────────────────────────────────────

type F<T = unknown> = { value: T; confidence: number; source: string };
type Enrichment = {
  status: Status; engine: string | null; domain: string | null; confidence: number; summary: string | null; error: string | null; finishedAt: string | null; applied: string[];
  data: Record<string, F | undefined>; sources: { url: string; title: string | null }[];
  checks: { email: { syntax: boolean; domain: string | null; free: boolean; disposable: boolean; mx: boolean | null } | null; phone: { valid: boolean; type: string | null; country: string | null; e164: string | null; suggestion?: { e164: string; country: string; reason: string } | null } | null; seniority: string | null; department: string | null; domainSource?: string | null; crawl?: { status: string; error: string | null } | null };
};

const LABELS: [string, string][] = [
['companyName', 'Company'], ['industry', 'Industry'], ['subIndustry', 'Specialty'], ['description', 'About'], ['keywords', 'Keywords'], ['companySize', 'Employees'], ['foundedYear', 'Founded'], ['headquarters', 'Headquarters'], ['website', 'Website'], ['companyPhone', 'Company phone'], ['companyEmail', 'Company email'], ['linkedin', 'LinkedIn'], ['b2b', 'Sells to businesses'], ['seniority', 'Seniority'], ['department', 'Department']];

function show(k: string, v: unknown): React.ReactNode {
  if (v == null) return '—';
  if (Array.isArray(v)) return <span className="flex flex-wrap gap-1">{v.map((x) => <Badge key={String(x)} tone="outline">{String(x)}</Badge>)}</span>;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return Object.values(v as Record<string, string | null>).filter(Boolean).join(', ') || '—';
  const s = String(v);
  if (/^https?:\/\//.test(s)) return <a href={s} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 break-all hover:underline">{s.replace(/^https?:\/\/(www\.)?/, '')}<ExternalLink className="size-3 shrink-0" /></a>;
  return k === 'description' ? <span className="leading-relaxed">{s}</span> : s;
}

export function LeadResearchCard({ leadId, canRun, onApplied }: { leadId: string; canRun: boolean; onApplied?: () => void }) {
  const { data, refetch } = useApiQuery<{ enrichment: Enrichment | null }>(`/api/v1/leads/${leadId}/enrichment`, { refetchInterval: 0 });
  const [busy, setBusy] = useState(false);
  const e = data?.enrichment ?? null;
  const pendingStatus = e?.status === 'QUEUED' || e?.status === 'RUNNING';
  useEffect(() => {
    if (!pendingStatus) return;
    const t = setInterval(() => refetch(), 3000);
    return () => clearInterval(t);
  }, [pendingStatus, refetch]);
  const run = async () => {
    setBusy(true);
    try { await api(`/api/v1/leads/${leadId}/enrichment`, { body: { force: true } }); await refetch(); onApplied?.(); toast.success('Research complete'); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };
  const apply = async (mode: 'empty' | 'overwrite') => {
    try { const r = await api<{ applied: string[] }>(`/api/v1/leads/${leadId}/enrichment`, { method: 'PATCH', body: { mode } }); toast.success(r.applied.length ? `Saved: ${r.applied.join(', ')}` : 'Nothing new to save'); refetch(); onApplied?.(); } catch (err) { toast.error(errorMessage(err)); }
  };
  const rows = e ? LABELS.filter(([k]) => e.data[k]) : [];
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2">AI company research {e && <ResearchBadge e={e} />}</span>}
        description={e?.finishedAt ? `${e.engine === 'claude' ? 'Claude' : 'Rules'} · ${e.domain ?? 'no company site'} · ${fmtAgo(e.finishedAt)}` : 'Verified, sourced facts about this lead’s company'}
        actions={canRun && <Button size="sm" variant={e ? 'secondary' : 'primary'} loading={busy || pendingStatus} onClick={run}>{e ? <><RefreshCw /> Re-run</> : <><Sparkles /> Research</>}</Button>} />
      {!e ? (
        <div className="px-4 py-8 text-center text-[12.5px] text-subtle">{busy ? 'Reading the company website and verifying contact details…' : 'Not researched yet.'}</div>
      ) : (
        <div className="flex flex-col">
          {e.error && <div className="px-4 pt-3"><InlineNotice tone="warn">{e.error}</InlineNotice></div>}
          {e.checks?.crawl && e.checks.crawl.status !== 'ok' && <div className="px-4 pt-3"><InlineNotice>{e.checks.crawl.status === 'robots' ? 'The company website does not allow automated reading (robots.txt).' : `Company website unavailable${e.checks.crawl.error ? ` — ${e.checks.crawl.error}` : ''}.`}</InlineNotice></div>}
          <div className="grid grid-cols-2 gap-2 px-4 pt-3.5 @container sm:grid-cols-4">
            <Check icon={Mail} label="Email domain" ok={e.checks?.email ? e.checks.email.syntax && e.checks.email.mx !== false && !e.checks.email.disposable : null} text={!e.checks?.email ? 'No email' : e.checks.email.disposable ? 'Disposable' : e.checks.email.mx === false ? 'No mail server' : e.checks.email.free ? 'Personal (free) email' : 'Business email'} />
            <Check icon={Phone} label="Phone" ok={e.checks?.phone ? e.checks.phone.valid || Boolean(e.checks.phone.suggestion) : null} text={!e.checks?.phone ? 'No phone' : e.checks.phone.valid ? `${(e.checks.phone.type ?? 'valid').replace(/_/g, ' ').toLowerCase()}${e.checks.phone.country ? ` · ${e.checks.phone.country}` : ''}` : e.checks.phone.suggestion ? `Wrong country code → ${e.checks.phone.suggestion.country} ${e.checks.phone.suggestion.e164}` : 'Invalid number'} />
            <Check icon={Globe} label="Company site" ok={e.domain ? e.checks?.crawl?.status === 'ok' : null} text={e.domain ? `${e.domain}${e.checks?.domainSource ? ` (from ${e.checks.domainSource})` : ''}` : 'Not found'} />
            <Check icon={CheckCircle2} label="Confidence" ok={e.confidence >= 60} text={`${e.confidence}% overall`} />
          </div>
          {rows.length > 0 && (
            <dl className="mt-3 grid grid-cols-[minmax(110px,32%)_1fr_44px] gap-x-3 border-t border-border px-4 py-3 text-[12.5px]">
              {rows.map(([k, label]) => {
                const f = e.data[k]!;
                return (
                  <div key={k} className="contents">
                    <dt className="py-1.5 text-subtle">{label}</dt>
                    <dd className="min-w-0 py-1.5">{show(k, f.value)}</dd>
                    <dd className="py-1.5 text-right"><span title={`Source: ${f.source}`} className={cn('tnum text-[11px]', f.confidence >= 75 ? 'text-fg-2' : f.confidence >= 55 ? 'text-muted' : 'text-warn')}>{f.confidence}%</span></dd>
                  </div>
                );
              })}
            </dl>
          )}
          {(() => {
            const reg = e.data.registry?.value as (Omit<Registration, 'registeredIn'> & { district?: string | null; state?: string | null; jurisdiction?: string | null }) | undefined;
            const name = (e.data.companyName?.value as string | undefined) ?? null;
            return (
              <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
                {reg && <RegistrationBlock reg={{ ...reg, registeredIn: [reg.district, reg.state].filter(Boolean).join(', ') || null } as Registration} />}
                {name && <CompanyLinks links={companyLinks(name, { cin: reg?.regId ?? null, india: reg?.jurisdiction === 'in' || /\b(pvt|private limited|llp)\b/i.test(name) || e.checks?.phone?.country === 'IN' })} />}
                {canRun && <CinInput current={reg?.regId ?? null} onSave={async (cin) => { try { await api(`/api/v1/leads/${leadId}/enrichment/cin`, { body: { cin } }); toast.success('Registration number saved for this company'); await refetch(); } catch (err) { toast.error(errorMessage(err)); } }} />}
              </div>
            );
          })()}
          {e.sources.length > 0 && (
            <div className="border-t border-border px-4 py-3">
              <div className="eyebrow mb-1.5">Sources</div>
              <ul className="flex flex-col gap-1 text-[12px]">{e.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-muted hover:text-fg hover:underline">{s.title || s.url}<ExternalLink className="size-3" /></a></li>)}</ul>
            </div>
          )}
          {canRun && (e.status === 'DONE' || e.status === 'PARTIAL') && rows.length > 0 && (
            <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-[11.5px] text-subtle">
              <span>{e.applied.length ? `Saved to lead: ${e.applied.join(', ')}` : 'Not saved to the lead yet'}</span>
              <span className="flex gap-1"><Button size="xs" variant="ghost" onClick={() => apply('empty')}>Fill empty</Button><Button size="xs" variant="ghost" onClick={() => apply('overwrite')}>Overwrite</Button></span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Check({ icon: I, label, ok, text }: { icon: typeof Mail; label: string; ok: boolean | null; text: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-2 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[10.5px] tracking-wide text-subtle uppercase"><I className="size-3" />{label}</div>
      <div className={cn('mt-1 truncate text-[12px] font-medium', ok === false ? 'text-danger' : ok ? 'text-fg' : 'text-muted')} title={text}>{text}</div>
    </div>
  );
}
