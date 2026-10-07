'use client';
import { Check, CheckCircle2, CircleAlert, Copy, KeyRound, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/overlay';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo } from '@/lib/format';

type DnsRecord = { host: string; type: string; value: string };
type Check = { key: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string; fix?: DnsRecord | null };
type Result = { score: number; domain: string; provider: string | null; checks: Check[]; dkim: DnsRecord | null; dkimEnabled: boolean; checkedAt: string };

export function deliverabilityTone(score: number | null | undefined) {
  return score == null ? 'neutral' : score >= 85 ? 'ok' : score >= 60 ? 'warn' : 'danger';
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="grid grid-cols-[60px_1fr_auto] items-center gap-2">
      <span className="text-[11px] text-subtle">{label}</span>
      <span className="font-mono text-[11px] break-all text-fg-2">{value}</span>
      <Button size="icon" variant="ghost" aria-label={`Copy ${label}`} onClick={() => { navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? <Check /> : <Copy />}</Button>
    </div>
  );
}

function RecordBox({ r }: { r: DnsRecord }) {
  return (
    <div className="mt-2 flex flex-col gap-1 rounded-md border border-border bg-surface-2 p-2.5">
      <CopyRow label="Type" value={r.type} />
      <CopyRow label="Host" value={r.host} />
      <CopyRow label="Value" value={r.value} />
    </div>
  );
}

const ICON = { pass: CheckCircle2, warn: TriangleAlert, fail: CircleAlert };
const TONE = { pass: 'text-ok', warn: 'text-warn', fail: 'text-danger' };

/** Domain authentication and inbox-placement check for one sender, with DKIM key setup. */
export function SenderDeliverability({ sender, onClose }: { sender: { id: string; label: string; fromEmail: string }; onClose: () => void }) {
  const [res, setRes] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>('check');

  const run = async () => {
    setBusy('check');
    setError(null);
    try {
      setRes(await api<Result>(`/api/v1/email/smtp/${sender.id}/deliverability`, { method: 'POST' }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    let live = true;
    api<Result>(`/api/v1/email/smtp/${sender.id}/deliverability`, { method: 'POST' })
      .then((r) => live && setRes(r))
      .catch((e) => live && setError(errorMessage(e)))
      .finally(() => live && setBusy(null));
    return () => { live = false; };
  }, [sender.id]);

  const dkim = async (action: 'generate' | 'enable' | 'disable') => {
    setBusy(action);
    try {
      await api(`/api/v1/email/smtp/${sender.id}/dkim`, { body: { action } });
      toast.success(action === 'generate' ? 'DKIM key created. Add the DNS record below.' : action === 'enable' ? 'DKIM signing is on' : 'DKIM signing is off');
      await run();
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="lg" title={`Deliverability · ${sender.label}`} description={`How likely mail from ${sender.fromEmail} is to reach the inbox, and exactly what to fix.`}
      footer={<div className="flex justify-between gap-2"><span className="self-center text-[11px] text-subtle">{res ? `Checked ${fmtAgo(res.checkedAt)} · DNS changes can take up to an hour to appear` : ''}</span><Button loading={busy === 'check'} onClick={run}><RefreshCw /> Check again</Button></div>}>
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : !res ? <Skeleton className="h-96" /> : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4 rounded-lg border border-border p-4">
            <div className={cn('tnum text-[34px] leading-none font-semibold', res.score >= 85 ? 'text-ok' : res.score >= 60 ? 'text-warn' : 'text-danger')}>{res.score}</div>
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{res.score >= 85 ? 'Ready for the inbox' : res.score >= 60 ? 'Some mail may land in spam' : 'Mail is likely to land in spam'}</div>
              <div className="text-[12px] text-muted">Domain {res.domain}{res.provider ? ` · sending through ${res.provider}` : ''}</div>
            </div>
          </div>

          <ol className="flex flex-col gap-2.5">
            {res.checks.map((c) => {
              const Icon = ICON[c.status];
              return (
                <li key={c.key} className="rounded-lg border border-border p-3">
                  <div className="flex items-start gap-2">
                    <Icon className={cn('mt-0.5 size-4 shrink-0', TONE[c.status])} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[12.5px] font-medium">{c.label}<Badge tone={c.status === 'pass' ? 'ok' : c.status === 'warn' ? 'warn' : 'danger'}>{c.status === 'pass' ? 'OK' : c.status === 'warn' ? 'Improve' : 'Fix'}</Badge></div>
                      <p className="mt-0.5 text-[12px] break-words text-muted">{c.detail}</p>
                      {c.fix && <><div className="mt-2 text-[11px] text-subtle">Add this record at your DNS provider:</div><RecordBox r={c.fix} /></>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 text-[12.5px] font-medium"><KeyRound className="size-4" />DKIM signing by markeetor</div>
            <p className="mt-1 text-[12px] text-muted">Signs every email from this sender with your domain, so Gmail, Yahoo and Outlook can verify it really came from you. Use this if your email provider doesn’t sign with your domain already.</p>
            {res.dkim && <RecordBox r={res.dkim} />}
            <div className="mt-3 flex flex-wrap gap-2">
              {!res.dkim && <Button size="sm" variant="primary" loading={busy === 'generate'} onClick={() => dkim('generate')}>Create DKIM key</Button>}
              {res.dkim && !res.dkimEnabled && <Button size="sm" variant="primary" loading={busy === 'enable'} onClick={() => dkim('enable')}>I’ve added it, verify &amp; turn on</Button>}
              {res.dkim && res.dkimEnabled && <Badge tone="ok"><CheckCircle2 className="size-3" /> Signing on</Badge>}
              {res.dkim && res.dkimEnabled && <Button size="sm" variant="ghost" loading={busy === 'disable'} onClick={() => dkim('disable')}>Turn off</Button>}
              {res.dkim && <Button size="sm" variant="ghost" loading={busy === 'generate'} onClick={() => dkim('generate')}>New key</Button>}
            </div>
          </div>

          <div className="rounded-lg border border-border p-3 text-[12px] leading-relaxed text-muted">
            <div className="mb-1 text-[12.5px] font-medium text-fg">Also important</div>
            <ul className="list-disc space-y-1 pl-4">
              <li>Warm up a new domain: start with 50–200 emails a day to people who expect them, then increase gradually over 2–4 weeks.</li>
              <li>Only email people who gave you their address. Purchased or scraped lists get reported as spam and sink your domain’s reputation.</li>
              <li>Keep the spam-complaint rate under 0.1% (Gmail’s hard limit is 0.3%). Watch it in Google Postmaster Tools.</li>
              <li>Send a test to mail-tester.com for an independent score, and check that the domain isn’t on a blocklist (e.g. mxtoolbox.com).</li>
            </ul>
          </div>
        </div>
      )}
    </Drawer>
  );
}
