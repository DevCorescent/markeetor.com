'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Cloud, CloudOff, Download, FileSpreadsheet, Loader2, RotateCcw, Sparkles, Wand2, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DataTable } from '@/components/data/data-table';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, DefinitionList } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select } from '@/components/ui/input';
import { Checkbox, Switch, Tooltip } from '@/components/ui/overlay';
import { Kpi, PageHeader } from '@/components/ui/page';
import { ErrorState, InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtDateTime, fmtInt } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';

type Options = { dedupeKeys: ('email' | 'phone')[]; onDuplicate: 'skip' | 'update' | 'create'; requireName: boolean; requireContact: boolean; requireEmail: boolean; requirePhone: boolean; defaultCountry: string; autoConfirm: boolean };
type Detection = Record<string, { field: string; confidence: number; reasons: string[]; sample: string[]; empty: boolean }>;
type Imp = {
  import: {
    id: string; code: string; fileName: string; fileSize: number; fileType: string; status: string; headers: string[]; mapping: Record<string, string>; options: Partial<Options>; source: string | null; campaign: string | null; tags: string[];
    totalRows: number; processedRows: number; validCount: number; invalidCount: number; duplicateCount: number; insertedCount: number; updatedCount: number; skippedCount: number; failedCount: number;
    error: string | null; confirmedAt: string | null; startedAt: string | null; completedAt: string | null; rolledBackAt: string | null; createdAt: string; updatedAt: string; fileDeletedAt: string | null;
    draftStep: string; sheetName: string | null; sheets: { name: string; rows: number }[]; headerRow: number; delimiter: string | null; encoding: string | null; detection: Detection;
  };
  creator: { name: string; email: string } | null;
  templates: { id: string; name: string; mapping: Record<string, string>; options: Options }[];
  sample: string[][];
  topRows: string[][];
  problems: string[];
  fields: { key: string; label: string }[];
};
type RowItem = { id: string; rowNumber: number; status: string; errors: string[]; normalized: { fullName?: string; email?: string; phone?: string; company?: string; country?: string; source?: string; score?: number }; leadId: string | null };
type Step = 'file' | 'mapping' | 'rules' | 'review' | 'import';

const DEFAULT_OPTS: Options = { dedupeKeys: ['email', 'phone'], onDuplicate: 'skip', requireName: true, requireContact: true, requireEmail: false, requirePhone: false, defaultCountry: 'US', autoConfirm: false };
const ACTIVE = ['VALIDATING', 'QUEUED', 'PROCESSING'];
const STEPS: { key: Step; label: string }[] = [{ key: 'file', label: 'File' }, { key: 'mapping', label: 'Columns' }, { key: 'rules', label: 'Rules' }, { key: 'review', label: 'Review' }, { key: 'import', label: 'Import' }];
const DELIMS: Record<string, string> = { ',': 'Comma', ';': 'Semicolon', '\t': 'Tab', '|': 'Pipe' };

export function ImportDetail({ id, canCreate, canRollback }: { id: string; canCreate: boolean; canRollback: boolean }) {
  const qc = useQueryClient();
  const url = `/api/v1/imports/${id}`;
  const [poll, setPoll] = useState(false);
  const { data, error, isLoading } = useApiQuery<Imp>(url, { refetchInterval: poll ? 1500 : undefined });
  const [step, setStep] = useState<Step | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const b = data?.import;
  const locked = Boolean(b && (b.confirmedAt || ['QUEUED', 'PROCESSING', 'COMPLETED', 'ROLLED_BACK', 'CANCELLED'].includes(b.status)));
  useEffect(() => setPoll(Boolean(b && ACTIVE.includes(b.status))), [b]);
  useEffect(() => {
    if (!b || step) return;
    setStep(locked ? 'import' : b.status === 'VALIDATING' ? 'review' : ((b.draftStep as Step) || (b.status === 'PREVIEW_READY' ? 'review' : 'file')));
  }, [b, step, locked]);
  useEffect(() => { if (b && locked && step !== 'import') setStep('import'); }, [b, locked, step]);

  /** Autosave: every edit is persisted as a draft so the wizard can be left and resumed. */
  const saveDraft = useCallback(async (patch: Record<string, unknown>) => {
    setSaveState('saving');
    try {
      await api(`${url}/draft`, { method: 'PATCH', body: patch });
      setSaveState('saved');
      if ('sheetName' in patch || 'headerRow' in patch || 'redetect' in patch || 'mapping' in patch || 'options' in patch) qc.invalidateQueries({ queryKey: [url] });
    } catch (e) {
      setSaveState('error');
      throw e;
    }
  }, [url, qc]);

  const go = (s: Step) => {
    setStep(s);
    if (!locked && s !== 'import' && s !== 'review') saveDraft({ step: s }).catch(() => null);
  };

  if (error) return <ErrorState description={errorMessage(error)} />;
  if (isLoading || !data || !b || !step) return <Skeleton className="h-96" />;
  const editable = canCreate && !locked && !b.fileDeletedAt && b.status !== 'VALIDATING';
  const reachable = (s: Step) => (locked ? s === 'import' || s === 'review' : s === 'import' ? false : s === 'review' ? ['VALIDATING', 'PREVIEW_READY'].includes(b.status) : true);

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Imports', href: '/admin/imports' }, { label: b.code }]}
        title={<span className="flex items-center gap-3"><FileSpreadsheet className="size-5 text-subtle" />{b.fileName}<StatusBadge status={locked ? b.status : b.status === 'UPLOADED' ? 'DRAFT' : b.status} /></span>}
        description={`${b.code} · ${(b.fileSize / 1024).toFixed(0)} KB · uploaded by ${data.creator?.name ?? '—'} ${fmtAgo(b.createdAt)}`}
        actions={!locked && (
          <span className="flex items-center gap-1.5 text-[11.5px] text-subtle">
            {saveState === 'saving' ? <><Loader2 className="size-3 animate-spin" /> Saving draft…</> : saveState === 'error' ? <><CloudOff className="size-3 text-danger" /> Draft not saved</> : <><Cloud className="size-3" /> Draft saved {fmtAgo(b.updatedAt)}</>}
          </span>
        )}
      />
      <nav aria-label="Import steps" className="mb-5 flex flex-wrap items-center gap-1">
        {STEPS.map((s, i) => {
          const idx = STEPS.findIndex((x) => x.key === step);
          const done = i < idx;
          const can = reachable(s.key) && s.key !== step;
          return (
            <div key={s.key} className="flex items-center gap-1">
              <button disabled={!can} onClick={() => go(s.key)} aria-current={s.key === step ? 'step' : undefined}
                className={cn('flex h-8 items-center gap-2 rounded-full border px-3 text-[12px] transition-colors', s.key === step ? 'border-fg bg-fg text-inverse' : done ? 'border-border-strong text-fg-2 hover:bg-surface-3' : 'border-border text-subtle', can && 'cursor-pointer hover:border-faint', !can && s.key !== step && 'cursor-default')}>
                <span className={cn('grid size-4 place-items-center rounded-full text-[9.5px]', s.key === step ? 'bg-inverse text-fg' : done ? 'bg-fg text-inverse' : 'border border-border-strong')}>{done ? <Check className="size-2.5" /> : i + 1}</span>
                {s.label}
              </button>
              {i < STEPS.length - 1 && <span className="h-px w-5 bg-border-strong" />}
            </div>
          );
        })}
      </nav>
      {b.error && <InlineNotice tone={b.status === 'FAILED' ? 'danger' : 'warn'} className="mb-4">{b.error}</InlineNotice>}
      {b.fileDeletedAt && !locked && <InlineNotice tone="warn" className="mb-4">The uploaded file was removed by the retention policy. Upload it again to continue.</InlineNotice>}

      {step === 'file' && <FileStep data={data} editable={editable} saveDraft={saveDraft} onNext={() => go('mapping')} />}
      {step === 'mapping' && <MappingStep data={data} editable={editable} saveDraft={saveDraft} onBack={() => go('file')} onNext={() => go('rules')} />}
      {step === 'rules' && <RulesStep data={data} editable={editable} saveDraft={saveDraft} onBack={() => go('mapping')} onValidated={() => setStep('review')} />}
      {step === 'review' && (b.status === 'VALIDATING' ? <Progress label="Validating every row, normalising contacts and checking duplicates…" value={null} /> : <ReviewStep data={data} canCreate={canCreate} locked={locked} onBack={() => go('rules')} onEdit={() => go('mapping')} />)}
      {step === 'import' && (['QUEUED', 'PROCESSING'].includes(b.status)
        ? <Progress label={b.status === 'QUEUED' ? 'Queued — waiting for the worker…' : `Writing leads… ${fmtInt(b.processedRows)} of ${fmtInt(b.validCount + b.duplicateCount)}`} value={b.validCount + b.duplicateCount ? b.processedRows / (b.validCount + b.duplicateCount) : 0} />
        : <ResultStep data={data} canCreate={canCreate} canRollback={canRollback} />)}
    </>
  );
}

function Progress({ label, value }: { label: string; value: number | null }) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-3 py-10">
        <div className="flex items-center gap-2 text-[13px]"><Loader2 className="size-4 animate-spin text-muted" />{label}</div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div className={cn('h-full rounded-full bg-fg transition-all', value == null && 'w-1/3 animate-pulse')} style={value != null ? { width: `${Math.max(2, value * 100)}%` } : undefined} />
        </div>
        <p className="text-xs text-subtle">Runs in a durable background job — you can leave this page; you’ll be notified when it finishes.</p>
      </CardBody>
    </Card>
  );
}

function StepFooter({ onBack, children }: { onBack?: () => void; children?: React.ReactNode }) {
  return (
    <div className="mt-4 flex items-center justify-between gap-2">
      {onBack ? <Button variant="ghost" onClick={onBack}><ArrowLeft /> Back</Button> : <span />}
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

// ── Step 1: file structure ─────────────────────────────────────────

function FileStep({ data, editable, saveDraft, onNext }: { data: Imp; editable: boolean; saveDraft: (p: Record<string, unknown>) => Promise<void>; onNext: () => void }) {
  const b = data.import;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const change = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try { await saveDraft(patch); } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  const mapped = Object.values(b.mapping).filter((v) => v !== 'ignore' && !v.startsWith('custom:')).length;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
      <Card>
        <CardHeader title="Detected structure" description="Everything here was worked out automatically — adjust only if it looks wrong." />
        <CardBody className="flex flex-col gap-4">
          <DefinitionList items={[
            ['Format', b.fileType === 'xlsx' ? 'Excel workbook' : `Delimited text · ${DELIMS[b.delimiter ?? ','] ?? b.delimiter}`],
            ...(b.encoding ? [['Encoding', b.encoding] as [string, string]] : []),
            ['Columns', `${b.headers.length} (${mapped} matched to lead fields)`],
            ['Header', b.headerRow === 0 ? 'No header row — columns were named automatically' : `Row ${b.headerRow}`],
          ]} />
          {b.sheets.length > 1 && (
            <Field label="Worksheet" hint="The sheet with the most rows was chosen for you">
              <Select disabled={!editable || busy} value={b.sheetName ?? ''} onChange={(e) => change({ sheetName: e.target.value })}>
                {b.sheets.map((s) => <option key={s.name} value={s.name}>{s.name} · {fmtInt(s.rows)} rows</option>)}
              </Select>
            </Field>
          )}
          <Field label="Header row" hint="Row containing the column names. Choose “None” if the first row is already data.">
            <Select disabled={!editable || busy} value={b.headerRow} onChange={(e) => change({ headerRow: Number(e.target.value) })}>
              <option value={0}>None — first row is data</option>
              {Array.from({ length: Math.max(1, Math.min(10, data.topRows.length)) }, (_, i) => <option key={i + 1} value={i + 1}>Row {i + 1}</option>)}
            </Select>
          </Field>
          {err && <InlineNotice tone="danger">{err}</InlineNotice>}
          {busy && <p className="flex items-center gap-1.5 text-xs text-subtle"><Loader2 className="size-3 animate-spin" />Re-analysing file…</p>}
        </CardBody>
      </Card>
      <Card className="min-w-0">
        <CardHeader title="Top of file" description="The highlighted row is used as column names" />
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px]">
            <tbody>
              {data.topRows.map((r, i) => (
                <tr key={i} className={cn('border-b border-border/60', i + 1 === b.headerRow ? 'bg-fg/10 font-medium text-fg' : i + 1 < b.headerRow ? 'text-faint line-through' : 'text-muted')}>
                  <td className="w-10 px-3 py-1.5 text-right font-mono text-[10.5px] text-subtle">{i + 1}</td>
                  {r.slice(0, 12).map((c, j) => <td key={j} className="max-w-[160px] truncate px-2 py-1.5">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="xl:col-span-2"><StepFooter><Button variant="primary" onClick={onNext}>Columns <ArrowRight /></Button></StepFooter></div>
    </div>
  );
}

// ── Step 2: column mapping ─────────────────────────────────────────

function ConfidenceChip({ c, field }: { c: number; field: string }) {
  if (field === 'ignore') return <Badge tone="dim">Ignored</Badge>;
  if (field.startsWith('custom:')) return <Badge tone="outline">Custom field</Badge>;
  if (c >= 0.8) return <Badge tone="ok"><CheckCircle2 className="size-3" /> High</Badge>;
  if (c >= 0.6) return <Badge tone="neutral">Medium</Badge>;
  return <Badge tone="warn">Check</Badge>;
}

function MappingStep({ data, editable, saveDraft, onBack, onNext }: { data: Imp; editable: boolean; saveDraft: (p: Record<string, unknown>) => Promise<void>; onBack: () => void; onNext: () => void }) {
  const b = data.import;
  const [mapping, setMapping] = useState<Record<string, string>>(b.mapping);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setMapping(b.mapping), [b.mapping]);
  const update = (next: Record<string, string>) => {
    setMapping(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => saveDraft({ mapping: next }).catch(() => null), 600);
  };
  const used = Object.values(mapping);
  const counts = useMemo(() => ({
    mapped: used.filter((v) => v !== 'ignore' && !v.startsWith('custom:')).length,
    custom: used.filter((v) => v.startsWith('custom:')).length,
    ignored: used.filter((v) => v === 'ignore').length,
  }), [used]);
  const t = new Set(used);
  const missing = [
    !t.has('fullName') && !t.has('firstName') && !t.has('lastName') ? 'a name column' : null,
    !t.has('email') && !t.has('phone') ? 'an email or phone column' : null,
  ].filter(Boolean);

  return (
    <>
      <Card>
        <CardHeader
          title="Match columns to lead fields"
          description={`${counts.mapped} matched · ${counts.custom} kept as custom fields · ${counts.ignored} ignored`}
          actions={editable && (
            <div className="flex gap-1.5">
              {data.templates.length > 0 && (
                <Select className="h-7 w-44" defaultValue="" aria-label="Apply template" onChange={(e) => { const tp = data.templates.find((x) => x.id === e.target.value); if (tp) update({ ...Object.fromEntries(b.headers.map((h) => [h, 'ignore'])), ...Object.fromEntries(Object.entries(tp.mapping).filter(([h]) => b.headers.includes(h))) }); }}>
                  <option value="">Apply saved template…</option>
                  {data.templates.map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
                </Select>
              )}
              <Button size="sm" variant="ghost" onClick={() => saveDraft({ redetect: true })}><Wand2 /> Re-run auto-detect</Button>
            </div>
          )}
        />
        {missing.length > 0 && <div className="border-b border-border px-4 py-2"><InlineNotice tone="warn">Still needed: {missing.join(' and ')}. Map it below, or relax the rules in the next step.</InlineNotice></div>}
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead><tr className="border-b border-border text-left text-[10.5px] uppercase tracking-[0.08em] text-subtle"><th className="h-8 px-4">Column in file</th><th className="px-3">Sample values</th><th className="w-[250px] px-3">Lead field</th><th className="w-[120px] px-3">Confidence</th></tr></thead>
            <tbody>
              {b.headers.map((h) => {
                const v = mapping[h] ?? 'ignore';
                const d = b.detection?.[h];
                const isCustom = v.startsWith('custom:');
                const auto = d && d.field === v;
                return (
                  <tr key={h} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-2 align-top"><div className="font-medium text-fg">{h}</div>{d && auto && d.reasons[0] && <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-subtle"><Sparkles className="size-2.5" />{d.reasons[0]}</div>}</td>
                    <td className="max-w-[300px] px-3 py-2 align-top"><div className="truncate text-muted">{(d?.sample ?? []).join(' · ') || <span className="text-faint">empty</span>}</div></td>
                    <td className="px-3 py-2 align-top">
                      <Select disabled={!editable} value={isCustom ? '__custom' : v} aria-label={`Field for ${h}`} onChange={(e) => update({ ...mapping, [h]: e.target.value === '__custom' ? `custom:${h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 40) || 'field'}` : e.target.value })}>
                        <option value="ignore">— Don’t import —</option>
                        {data.fields.map((f) => <option key={f.key} value={f.key} disabled={used.includes(f.key) && v !== f.key}>{f.label}</option>)}
                        <option value="__custom">Custom field…</option>
                      </Select>
                      {isCustom && <Input disabled={!editable} className="mt-1 h-7 font-mono text-[11.5px]" value={v.slice(7)} aria-label="Custom field key" onChange={(e) => update({ ...mapping, [h]: `custom:${e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40)}` })} />}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Tooltip content={d?.reasons.join(' · ') || 'Set manually'}><span><ConfidenceChip c={auto ? d!.confidence : 1} field={v} /></span></Tooltip>
                      {!auto && d && <div className="mt-1 text-[10.5px] text-subtle">changed by you</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <StepFooter onBack={onBack}><Button variant="primary" onClick={onNext}>Rules <ArrowRight /></Button></StepFooter>
    </>
  );
}

// ── Step 3: rules ──────────────────────────────────────────────────

function RulesStep({ data, editable, saveDraft, onBack, onValidated }: { data: Imp; editable: boolean; saveDraft: (p: Record<string, unknown>) => Promise<void>; onBack: () => void; onValidated: () => void }) {
  const b = data.import;
  const [opts, setOpts] = useState<Options>({ ...DEFAULT_OPTS, ...(b.options ?? {}) });
  const [source, setSource] = useState(b.source ?? '');
  const [campaign, setCampaign] = useState(b.campaign ?? '');
  const [tags, setTags] = useState(b.tags.join(', '));
  const [templateName, setTemplateName] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = (patch: Record<string, unknown>) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => saveDraft(patch).catch(() => null), 600);
  };
  const setO = (o: Options) => { setOpts(o); persist({ options: o }); };
  const validate = useApiMutation(
    () => api(`/api/v1/imports/${b.id}/config`, { method: 'PUT', body: { mapping: b.mapping, options: opts, source: source || null, campaign: campaign || null, tags: tags.split(',').map((x) => x.trim()).filter(Boolean), saveTemplateName: templateName.trim() || undefined } }),
    { success: opts.autoConfirm ? 'Validating — the import will run automatically if the file is clean' : 'Validation started', invalidate: [`/api/v1/imports/${b.id}`], onSuccess: onValidated },
  );
  const cancel = useApiMutation(() => api(`/api/v1/imports/${b.id}/cancel`, { method: 'POST' }), { success: 'Draft discarded', invalidate: ['/api/v1/imports'], onSuccess: () => (window.location.href = '/admin/imports') });

  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Required data" />
          <CardBody className="flex flex-col gap-2.5 text-[12.5px]">
            {([['requireName', 'Every lead needs a name'], ['requireContact', 'Every lead needs an email or phone'], ['requireEmail', 'Require a valid email'], ['requirePhone', 'Require a valid phone']] as const).map(([k, l]) => (
              <label key={k} className="flex items-center gap-2"><Checkbox disabled={!editable} checked={opts[k]} onCheckedChange={(c) => setO({ ...opts, [k]: c })} aria-label={l} />{l}</label>
            ))}
            <Field label="Default phone country" hint="Used when a row has no country and numbers lack a + prefix"><Input disabled={!editable} value={opts.defaultCountry} maxLength={2} onChange={(e) => setO({ ...opts, defaultCountry: e.target.value.toUpperCase() })} /></Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Duplicates" />
          <CardBody className="flex flex-col gap-3 text-[12.5px]">
            <div className="flex gap-4">{(['email', 'phone'] as const).map((k) => (
              <label key={k} className="flex items-center gap-2"><Checkbox disabled={!editable} checked={opts.dedupeKeys.includes(k)} onCheckedChange={(c) => { const next = c ? [...opts.dedupeKeys, k] : opts.dedupeKeys.filter((x) => x !== k); if (next.length) setO({ ...opts, dedupeKeys: next }); }} aria-label={`Match on ${k}`} />Match on {k}</label>
            ))}</div>
            <Field label="When a lead already exists">
              <Select disabled={!editable} value={opts.onDuplicate} onChange={(e) => setO({ ...opts, onDuplicate: e.target.value as Options['onDuplicate'] })}>
                <option value="skip">Skip the row</option>
                <option value="update">Update the existing lead with new values</option>
                <option value="create">Create anyway, flagged as duplicate</option>
              </Select>
            </Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Attribution & tags" />
          <CardBody className="flex flex-col gap-3">
            <Field label="Source" hint="Used where the file has no source column"><Input disabled={!editable} value={source} onChange={(e) => { setSource(e.target.value); persist({ source: e.target.value || null }); }} placeholder="e.g. Trade Show" /></Field>
            <Field label="Campaign"><Input disabled={!editable} value={campaign} onChange={(e) => { setCampaign(e.target.value); persist({ campaign: e.target.value || null }); }} /></Field>
            <Field label="Batch tags" hint="Comma-separated"><Input disabled={!editable} value={tags} onChange={(e) => { setTags(e.target.value); persist({ tags: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }); }} /></Field>
          </CardBody>
        </Card>
      </div>
      <Card className="mt-4">
        <CardBody className="flex flex-wrap items-center gap-4">
          <label className="flex flex-1 items-center gap-3 text-[12.5px]">
            <Switch disabled={!editable} checked={opts.autoConfirm} onCheckedChange={(v) => setO({ ...opts, autoConfirm: v })} aria-label="Auto-import" />
            <span><span className="text-fg">Import automatically after validation</span><span className="block text-[11.5px] text-subtle">Skips the review step when no more than 25% of rows are invalid. Otherwise it stops for review.</span></span>
          </label>
          <Field label="Save these settings as a template (optional)" className="w-72"><Input disabled={!editable} value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="e.g. Facebook lead export" /></Field>
        </CardBody>
      </Card>
      {validate.error && <InlineNotice tone="danger" className="mt-3">{errorMessage(validate.error)}</InlineNotice>}
      <StepFooter onBack={onBack}>
        {editable && <Button variant="ghost" onClick={() => cancel.mutate(undefined)} loading={cancel.isPending}><X /> Discard draft</Button>}
        <Button variant="primary" disabled={!editable} loading={validate.isPending} onClick={() => validate.mutate(undefined)}>{opts.autoConfirm ? <><Sparkles /> Validate & import</> : <>Validate file <ArrowRight /></>}</Button>
      </StepFooter>
    </>
  );
}

// ── Step 4: review ─────────────────────────────────────────────────

function RowsTable({ id, initialStatus }: { id: string; initialStatus?: string }) {
  const [status, setStatus] = useState(initialStatus ?? '');
  const [page, setPage] = useState(1);
  const { data, isFetching } = useApiQuery<{ total: number; rows: RowItem[] }>(`/api/v1/imports/${id}/rows?page=${page}&pageSize=25${status ? `&status=${status}` : ''}`);
  const columns = useMemo<ColumnDef<RowItem, unknown>[]>(() => [
    { id: 'row', header: 'Row', cell: ({ row: { original: r } }) => <span className="tnum text-subtle">{r.rowNumber}</span> },
    { id: 'status', header: 'Outcome', cell: ({ row: { original: r } }) => <StatusBadge status={r.status} /> },
    { id: 'name', header: 'Name', cell: ({ row: { original: r } }) => (r.leadId ? <Link className="hover:underline" href={`/admin/leads/${r.leadId}`}>{r.normalized.fullName ?? '—'}</Link> : (r.normalized.fullName ?? '—')) },
    { id: 'contact', header: 'Contact (masked)', cell: ({ row: { original: r } }) => <span className="font-mono text-[11.5px] text-muted">{r.normalized.email ?? r.normalized.phone ?? '—'}</span> },
    { id: 'company', header: 'Company', cell: ({ row: { original: r } }) => r.normalized.company ?? '—' },
    { id: 'country', header: 'Country', cell: ({ row: { original: r } }) => <span className="text-muted">{r.normalized.country ?? '—'}</span> },
    { id: 'errors', header: 'Messages', cell: ({ row: { original: r } }) => <div className="max-w-[420px] truncate whitespace-normal text-[11.5px] text-muted">{r.errors.join(' · ') || '—'}</div> },
  ], []);
  return (
    <DataTable columns={columns} data={data?.rows ?? []} total={data?.total ?? 0} page={page} pageSize={25} onPage={setPage} loading={isFetching} getRowId={(r) => r.id} dense
      toolbar={<Select className="h-7 w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Filter rows"><option value="">All rows</option>{['VALID', 'INVALID', 'DUPLICATE', 'INSERTED', 'UPDATED', 'SKIPPED', 'FAILED'].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</Select>} />
  );
}

function ReviewStep({ data, canCreate, locked, onBack, onEdit }: { data: Imp; canCreate: boolean; locked: boolean; onBack: () => void; onEdit: () => void }) {
  const b = data.import;
  const opts = { ...DEFAULT_OPTS, ...b.options };
  const [confirm, setConfirm] = useState(false);
  const confirmM = useApiMutation(() => api(`/api/v1/imports/${b.id}/confirm`, { method: 'POST' }), { success: 'Import queued', invalidate: [`/api/v1/imports/${b.id}`] });
  const toWrite = b.validCount + (opts.onDuplicate === 'skip' ? 0 : b.duplicateCount);
  const quality = b.totalRows ? b.validCount / b.totalRows : 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
        <Kpi label="Rows read" value={fmtInt(b.totalRows)} />
        <Kpi label="Ready" value={fmtInt(b.validCount)} sub={`${(quality * 100).toFixed(0)}% of rows`} />
        <Kpi label="Duplicates" value={fmtInt(b.duplicateCount)} sub={opts.onDuplicate === 'skip' ? 'will be skipped' : opts.onDuplicate === 'update' ? 'will update existing' : 'created & flagged'} />
        <Kpi label="Invalid" value={fmtInt(b.invalidCount)} sub="will be rejected" />
        <Kpi label="Will be written" value={fmtInt(toWrite)} />
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-3" aria-label="Row quality">
        <div className="flex h-full">
          <div className="bg-fg" style={{ width: `${(b.validCount / Math.max(1, b.totalRows)) * 100}%` }} />
          <div className="bg-muted/60" style={{ width: `${(b.duplicateCount / Math.max(1, b.totalRows)) * 100}%` }} />
          <div className="bg-danger/70" style={{ width: `${(b.invalidCount / Math.max(1, b.totalRows)) * 100}%` }} />
        </div>
      </div>
      <RowsTable id={b.id} initialStatus={b.invalidCount ? 'INVALID' : ''} />
      {!locked && (
        <StepFooter onBack={onBack}>
          {canCreate && <a href={`/api/v1/imports/${b.id}/rejected`} className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] text-muted hover:bg-surface-3 hover:text-fg"><Download className="size-3.5" /> Rejected rows</a>}
          <Button variant="ghost" onClick={onEdit}>Change mapping</Button>
          {canCreate && <Button variant="primary" disabled={!toWrite} onClick={() => setConfirm(true)}>Import {fmtInt(toWrite)} leads <ArrowRight /></Button>}
        </StepFooter>
      )}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Start import" confirmLabel="Import" typed={toWrite >= 1000 ? 'IMPORT' : undefined}
        description={`${fmtInt(toWrite)} lead record(s) will be written by a background job. Completed imports can be rolled back.`} onConfirm={() => confirmM.mutateAsync(undefined)} />
    </div>
  );
}

// ── Step 5: result ─────────────────────────────────────────────────

function ResultStep({ data, canCreate, canRollback }: { data: Imp; canCreate: boolean; canRollback: boolean }) {
  const b = data.import;
  const [rb, setRb] = useState(false);
  const retry = useApiMutation(() => api(`/api/v1/imports/${b.id}/retry`, { method: 'POST' }), { success: 'Retry queued', invalidate: [`/api/v1/imports/${b.id}`] });
  const rollback = useApiMutation((reason: string) => api<{ archived: number; keptAllocated: number; restored: number }>(`/api/v1/imports/${b.id}/rollback`, { body: { reason } }), {
    success: (r) => `Rolled back: ${r.archived} archived, ${r.restored} restored, ${r.keptAllocated} kept (allocated)`, invalidate: [`/api/v1/imports/${b.id}`],
  });
  const leadsFilter = encodeURIComponent(JSON.stringify({ conditions: [{ field: 'importBatchId', op: 'in', value: [b.id] }] }));
  return (
    <div className="flex flex-col gap-4">
      {b.status === 'COMPLETED' && <InlineNotice><span className="text-fg">Import complete.</span> {fmtInt(b.insertedCount)} new leads are in the repository and ready to distribute. <Link className="underline" href={`/admin/leads?filter=${leadsFilter}`}>View them</Link></InlineNotice>}
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
        <Kpi label="Inserted" value={fmtInt(b.insertedCount)} href={`/admin/leads?filter=${leadsFilter}`} />
        <Kpi label="Updated" value={fmtInt(b.updatedCount)} />
        <Kpi label="Skipped" value={fmtInt(b.skippedCount)} />
        <Kpi label="Invalid" value={fmtInt(b.invalidCount)} />
        <Kpi label="Failed" value={fmtInt(b.failedCount)} />
      </div>
      <Card>
        <CardHeader title="Batch details" actions={
          <div className="flex gap-2">
            {canCreate && <a href={`/api/v1/imports/${b.id}/rejected`} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted hover:bg-surface-3 hover:text-fg"><Download className="size-3.5" /> Rejected rows</a>}
            {canCreate && b.status === 'FAILED' && b.confirmedAt && <Button size="sm" onClick={() => retry.mutate(undefined)} loading={retry.isPending}>Retry</Button>}
            {canRollback && b.status === 'COMPLETED' && <Button size="sm" variant="danger" onClick={() => setRb(true)}><RotateCcw /> Roll back</Button>}
          </div>
        } />
        <CardBody>
          <DefinitionList items={[
            ['Status', <StatusBadge key="s" status={b.status} />], ['Source / campaign', [b.source, b.campaign].filter(Boolean).join(' · ') || '—'],
            ['Tags', b.tags.length ? b.tags.map((t) => <Badge key={t} tone="outline" className="mr-1">{t}</Badge>) : '—'],
            ['Duplicate rule', `${(b.options.dedupeKeys ?? []).join(' + ')} → ${b.options.onDuplicate ?? 'skip'}`],
            ['Mode', b.options.autoConfirm ? 'Automatic' : 'Reviewed'], ['Started', fmtDateTime(b.startedAt)], ['Completed', fmtDateTime(b.completedAt)], ['Rolled back', fmtDateTime(b.rolledBackAt)],
            ['Uploaded file', b.fileDeletedAt ? `Deleted ${fmtDateTime(b.fileDeletedAt)} (retention policy)` : 'Retained until the retention period ends'],
          ]} />
        </CardBody>
      </Card>
      <RowsTable id={b.id} />
      <ConfirmDialog open={rb} onOpenChange={setRb} title="Roll back import" danger requireReason confirmLabel="Roll back"
        description="Inserted leads that have not been allocated are archived (never deleted); leads updated by this import are restored to their previous values. Allocated leads are kept."
        onConfirm={(reason) => rollback.mutateAsync(reason)} />
    </div>
  );
}
