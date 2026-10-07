'use client';
import { KeyRound, Send } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/overlay';
import { SimpleTable } from '@/components/ui/simple-table';
import { ErrorState, InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { ACCOUNT_VARIABLES, VARIABLES, type EmailDesign } from '@/lib/email/types';
import { fmtAgo, fmtDateTime, fmtInt } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { EmailEditor, type Sender } from './editor';

type Settings = {
  enabled: boolean; smtpAccountId: string | null; sources: string[]; timing: 'immediate' | 'delay' | 'daily'; delayMinutes: number;
  dailyTime: string; timezone: string; passwordExpiryDays: number; subject: string; preheader: string | null; design: EmailDesign;
};
type ImportRow = {
  id: string; code: string; fileName: string; source: string | null; insertedCount: number; completedAt: string;
  campaign: { id: string; status: string; sentCount: number; failedCount: number; skippedCount: number; totalRecipients: number; scheduledFor: string | null } | null;
};
type Overview = { settings: Settings; senders: Sender[]; sources: { source: string; leads: number }[]; imports: ImportRow[] };

const WELCOME_VARIABLES = [...ACCOUNT_VARIABLES, ...VARIABLES];
const TIMING = [
  { key: 'immediate', label: 'Right after the import' },
  { key: 'delay', label: 'After a delay' },
  { key: 'daily', label: 'At a set time each day' },
] as const;

export function WelcomeEmails({ base }: { base: string }) {
  const { data, error, isLoading } = useApiQuery<Overview>('/api/v1/email/welcome', { refetchInterval: 15_000 });
  // Unsaved edits; null means the form shows the saved settings.
  const [draft, setDraft] = useState<Settings | null>(null);
  const [sendFor, setSendFor] = useState<ImportRow | null>(null);
  const timezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return ['UTC'];
    }
  }, []);
  const save = useApiMutation((body: Settings) => api<{ settings: Settings }>('/api/v1/email/welcome', { method: 'PUT', body }), {
    success: 'Welcome email settings saved', invalidate: ['/api/v1/email/welcome'], onSuccess: () => setDraft(null),
  });
  const sendNow = useApiMutation((id: string) => api<{ campaignId: string }>(`/api/v1/email/welcome/imports/${id}`, { method: 'POST' }), {
    success: 'Welcome emails queued', invalidate: ['/api/v1/email/welcome', '/api/v1/email/campaigns'],
  });

  if (error) return <ErrorState description={errorMessage(error)} />;
  if (isLoading || !data) return <Skeleton className="h-[640px]" />;
  const v = draft ?? data.settings;
  const dirty = draft !== null;
  const set = (patch: Partial<Settings>) => setDraft({ ...v, ...patch });
  const toggleSource = (src: string) => set({ sources: v.sources.includes(src) ? v.sources.filter((x) => x !== src) : [...v.sources, src] });
  const delayHours = v.delayMinutes % 60 === 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-md bg-accent-dim text-accent"><KeyRound className="size-3.5" /></span>Welcome emails</span>}
          description="When an import adds new leads to the repository, each lead with a valid email gets their own client workspace and an email with a username and temporary password."
          actions={<label className="flex items-center gap-2 text-[12.5px]"><span className={v.enabled ? 'text-fg' : 'text-subtle'}>{v.enabled ? 'On' : 'Off'}</span><Switch checked={v.enabled} onCheckedChange={(c) => set({ enabled: c })} aria-label="Send welcome emails automatically" /></label>}
        />
        <CardBody className="flex flex-col gap-2 text-[12.5px] text-muted">
          <InlineNotice tone="neutral">
            Each recipient becomes the <strong>Client Owner</strong> of a new workspace named after their company. They must choose a new password the first time they sign in, and the temporary password stops working after {v.passwordExpiryDays} day{v.passwordExpiryDays === 1 ? '' : 's'}. Leads that already have an account, have unsubscribed or have no valid email are skipped.
          </InlineNotice>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="When to send" description="Counted from the moment an import finishes." />
          <CardBody className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center rounded-md border border-border bg-surface p-0.5">
              {TIMING.map((t) => (
                <button key={t.key} type="button" onClick={() => set({ timing: t.key })} className={cn('h-7 flex-1 rounded px-2.5 text-[12px] whitespace-nowrap', v.timing === t.key ? 'bg-fg text-inverse' : 'text-muted hover:text-fg')}>{t.label}</button>
              ))}
            </div>
            {v.timing === 'delay' && (
              <Field label="Wait">
                <div className="flex gap-2">
                  <Input type="number" min={1} className="w-28" value={delayHours ? v.delayMinutes / 60 : v.delayMinutes} onChange={(e) => set({ delayMinutes: Math.max(1, Math.round(Number(e.target.value) || 1) * (delayHours ? 60 : 1)) })} />
                  <Select className="w-32" value={delayHours ? 'hours' : 'minutes'} onChange={(e) => set({ delayMinutes: e.target.value === 'hours' ? Math.max(1, Math.round(v.delayMinutes / 60)) * 60 : v.delayMinutes + 1 })}>
                    <option value="minutes">minutes</option><option value="hours">hours</option>
                  </Select>
                </div>
              </Field>
            )}
            {v.timing === 'daily' && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr]">
                <Field label="Time"><Input type="time" value={v.dailyTime} onChange={(e) => set({ dailyTime: e.target.value })} /></Field>
                <Field label="Time zone"><Select value={v.timezone} onChange={(e) => set({ timezone: e.target.value })}>{timezones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}</Select></Field>
              </div>
            )}
            <p className="text-[11.5px] text-subtle">
              {v.timing === 'immediate' && 'Emails start going out as soon as the import completes, at the sender’s per-minute rate.'}
              {v.timing === 'delay' && `Emails start ${delayHours ? `${v.delayMinutes / 60} hour${v.delayMinutes === 60 ? '' : 's'}` : `${v.delayMinutes} minute${v.delayMinutes === 1 ? '' : 's'}`} after the import completes.`}
              {v.timing === 'daily' && `Imports wait for the next ${v.dailyTime} (${v.timezone}). Scheduled sends appear under Campaigns, where you can cancel them.`}
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Who gets it" description="Which leads to welcome, and the mailbox it comes from." />
          <CardBody className="flex flex-col gap-3">
            <Field label="Lead sources" hint={v.sources.length ? `Only leads from ${v.sources.length} selected source${v.sources.length === 1 ? '' : 's'}.` : 'No source selected: every new lead is welcomed.'}>
              {data.sources.length ? (
                <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                  {data.sources.map((s) => (
                    <button key={s.source} type="button" onClick={() => toggleSource(s.source)} aria-pressed={v.sources.includes(s.source)}
                      className={cn('rounded-full border px-2.5 py-1 text-[11.5px]', v.sources.includes(s.source) ? 'border-fg bg-fg text-inverse' : 'border-border text-muted hover:border-border-strong hover:text-fg')}>
                      {s.source} <span className="opacity-60">{fmtInt(s.leads)}</span>
                    </button>
                  ))}
                </div>
              ) : <span className="text-[12px] text-subtle">No lead sources yet. Set a source when importing to filter by it.</span>}
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_150px]">
              <Field label="Send from">
                <Select value={v.smtpAccountId ?? ''} onChange={(e) => set({ smtpAccountId: e.target.value || null })}>
                  <option value="">Default platform sender</option>
                  {data.senders.map((s) => <option key={s.id} value={s.id}>{s.label} · {s.fromEmail}{s.status !== 'VERIFIED' ? ` (${s.status.toLowerCase()})` : ''}</option>)}
                </Select>
              </Field>
              <Field label="Password valid for">
                <Select value={v.passwordExpiryDays} onChange={(e) => set({ passwordExpiryDays: Number(e.target.value) })}>
                  {[1, 2, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>)}
                </Select>
              </Field>
            </div>
            {!data.senders.length && <InlineNotice tone="warn">Add a platform sender under <strong>Senders</strong> before turning this on.</InlineNotice>}
          </CardBody>
        </Card>
      </div>

      <div>
        <div className="mb-2 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-[13.5px] font-medium">Welcome email</h2>
            <p className="text-[11.5px] text-subtle">Keep <span className="font-mono">{'{{username}}'}</span> and <span className="font-mono">{'{{temporaryPassword}}'}</span> in the body. The password is filled in per person at send time and is never stored or shown in the subject.</p>
          </div>
        </div>
        <EmailEditor
          value={{ subject: v.subject, preheader: v.preheader ?? '', design: v.design }}
          onChange={(d) => set({ subject: d.subject, preheader: d.preheader || null, design: d.design })}
          senders={data.senders}
          variables={WELCOME_VARIABLES}
        />
      </div>

      <Card>
        <CardHeader title="Recent imports" description="Welcome emails for each completed import. Use “Send now” for imports from before this was turned on." />
        <SimpleTable
          rows={data.imports}
          empty="No completed imports yet."
          columns={[
            { key: 'code', header: 'Import', render: (r) => <Link href={`${base}/imports/${r.id}`} className="block min-w-[160px] hover:underline"><span className="font-mono text-[11.5px]">{r.code}</span><span className="block truncate text-[11px] text-subtle">{r.fileName}</span></Link> },
            { key: 'source', header: 'Source', render: (r) => <span className="text-muted">{r.source ?? '—'}</span> },
            { key: 'insertedCount', header: 'New leads', render: (r) => <span className="tnum">{fmtInt(r.insertedCount)}</span> },
            { key: 'completedAt', header: 'Completed', render: (r) => <span className="text-subtle">{fmtAgo(r.completedAt)}</span> },
            {
              key: 'campaign', header: 'Welcome emails', render: (r) => !r.campaign ? <Badge>Not sent</Badge> : (
                <Link href={`${base}/email/campaigns/${r.campaign.id}`} className="flex items-center gap-2 hover:underline">
                  <StatusBadge status={r.campaign.status} />
                  <span className="tnum text-[11.5px] text-muted">{r.campaign.status === 'SCHEDULED' && r.campaign.scheduledFor ? fmtDateTime(r.campaign.scheduledFor) : `${fmtInt(r.campaign.sentCount)} sent · ${fmtInt(r.campaign.skippedCount)} skipped${r.campaign.failedCount ? ` · ${fmtInt(r.campaign.failedCount)} failed` : ''}`}</span>
                </Link>
              ),
            },
            { key: 'id', header: '', render: (r) => !r.campaign && r.insertedCount > 0 && <Button size="sm" onClick={() => setSendFor(r)}><Send /> Send now</Button> },
          ]}
        />
      </Card>

      {dirty && (
        <div className="sticky bottom-4 z-20 flex items-center justify-between gap-3 rounded-lg border border-border-strong bg-surface-2 px-4 py-2.5 shadow-[var(--raised-shadow)] animate-pop">
          <span className="text-[12.5px] text-muted">You have unsaved changes</span>
          <span className="flex gap-2"><Button variant="ghost" onClick={() => setDraft(null)}>Discard</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(v)}>Save changes</Button></span>
        </div>
      )}

      <ConfirmDialog
        open={!!sendFor}
        onOpenChange={(o) => !o && setSendFor(null)}
        title={`Send welcome emails for ${sendFor?.code}`}
        description={`Creates a workspace and temporary password for each new lead from this import (${fmtInt(sendFor?.insertedCount ?? 0)} added) and emails them now, using the saved welcome email${dirty ? ' (save your changes first to use them)' : ''}.`}
        confirmLabel="Send now"
        onConfirm={() => sendNow.mutateAsync(sendFor!.id)}
      />
    </div>
  );
}
