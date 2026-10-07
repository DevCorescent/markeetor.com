'use client';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api-client';
import { fmtAgo, fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/overlay';
import { InlineNotice } from '@/components/ui/states';

export function MfaCard({ enabled, recoveryLeft }: { enabled: boolean; recoveryLeft: number }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader
        title="Two-factor authentication"
        description="Time-based one-time codes from an authenticator app."
        actions={enabled ? <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Disable</Button> : <Button size="sm" variant="primary" onClick={() => (window.location.href = '/account/mfa-setup')}>Enable</Button>}
      />
      <CardBody className="flex items-center gap-3 text-[12.5px]">
        <Badge tone={enabled ? 'ok' : 'warn'} dot>{enabled ? 'Enabled' : 'Not enabled'}</Badge>
        {enabled && <span className="text-subtle">{recoveryLeft} recovery codes remaining</span>}
      </CardBody>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Disable two-factor authentication"
        description="Enter a current code from your authenticator to confirm."
        size="sm"
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" loading={busy} onClick={async () => {
          setBusy(true); setError(null);
          try { await api('/api/v1/auth/mfa/disable', { body: { code } }); window.location.reload(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
        }}>Disable</Button></>}
      >
        <Field label="Code"><Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" /></Field>
        {error && <InlineNotice tone="danger" className="mt-3">{error}</InlineNotice>}
      </Dialog>
    </Card>
  );
}

export function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Password" description="Changing your password signs out all other sessions." />
      <CardBody>
        <form
          className="grid max-w-md gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api('/api/v1/auth/password', { body: { currentPassword: current, newPassword: next } });
              toast.success('Password updated. Other sessions were signed out.');
              setCurrent('');
              setNext('');
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Current password"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></Field>
          <Field label="New password" hint="At least 12 characters; mix three of lowercase, uppercase, digits, symbols."><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required /></Field>
          {error && <InlineNotice tone="danger">{error}</InlineNotice>}
          <div><Button type="submit" variant="primary" loading={busy}>Update password</Button></div>
        </form>
      </CardBody>
    </Card>
  );
}

type S = { id: string; ip: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string; current: boolean };

export function SessionsCard() {
  const [sessions, setSessions] = useState<S[] | null>(null);
  const load = useCallback(() => api<{ sessions: S[] }>('/api/v1/auth/sessions').then((r) => setSessions(r.sessions)).catch(() => setSessions([])), []);
  useEffect(() => { load(); }, [load]);
  return (
    <Card>
      <CardHeader title="Active sessions" description="Devices currently signed in to your account." />
      <ul>
        {sessions?.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2.5 last:border-0">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px]"><span className="min-w-0 truncate">{s.userAgent?.replace(/\(.*?\)/g, '').slice(0, 80) || 'Unknown device'}</span>{s.current && <Badge tone="solid">This device</Badge>}</div>
              <div className="text-[11px] text-subtle">{s.ip ?? 'unknown IP'} · signed in {fmtDateTime(s.createdAt)} · active {fmtAgo(s.lastSeenAt)}</div>
            </div>
            {!s.current && (
              <Button size="sm" variant="ghost" onClick={async () => { await api('/api/v1/auth/sessions', { method: 'DELETE', body: { sessionId: s.id } }); toast.success('Session revoked'); load(); }}>Revoke</Button>
            )}
          </li>
        ))}
        {sessions?.length === 0 && <li className="px-4 py-6 text-xs text-subtle">No active sessions</li>}
      </ul>
    </Card>
  );
}
