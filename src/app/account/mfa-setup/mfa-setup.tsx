'use client';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { InlineNotice, Skeleton } from '@/components/ui/states';

export function MfaSetup({ home }: { home: string }) {
  const [data, setData] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ secret: string; qr: string }>('/api/v1/auth/mfa/enroll', { method: 'POST' }).then(setData).catch((e) => setError(errorMessage(e)));
  }, []);

  if (codes) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-4">
          <InlineNotice tone="warn">Save these recovery codes somewhere safe. Each can be used once if you lose your device. They will not be shown again.</InlineNotice>
          <div className="grid grid-cols-2 gap-2 rounded-md border border-border-strong bg-surface-2 p-4 font-mono text-[13px] sm:grid-cols-5">
            {codes.map((c) => <span key={c}>{c}</span>)}
          </div>
          <div><Button variant="primary" onClick={() => (window.location.href = home)}>I’ve saved my codes</Button></div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="grid grid-cols-1 gap-6 md:grid-cols-[220px_1fr]">
        <div>
          {data ? <img src={data.qr} alt="Authenticator QR code" className="size-[220px] rounded-md bg-white p-2" /> : <Skeleton className="size-[220px]" />}
        </div>
        <div className="flex flex-col gap-4">
          <ol className="list-decimal space-y-1.5 pl-4 text-[12.5px] text-muted">
            <li>Open an authenticator app (1Password, Authy, Google Authenticator…).</li>
            <li>Scan the QR code, or enter the setup key manually.</li>
            <li>Enter the 6-digit code it shows.</li>
          </ol>
          {data && (
            <Field label="Setup key">
              <code className="rounded-md border border-border-strong bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] break-all">{data.secret}</code>
            </Field>
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const res = await api<{ recoveryCodes: string[] }>('/api/v1/auth/mfa/confirm', { body: { code } });
                setCodes(res.recoveryCodes);
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Verification code" className="w-48">
              <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="font-mono tracking-[0.3em]" />
            </Field>
            <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>Verify & enable</Button>
          </form>
          {error && <InlineNotice tone="danger">{error}</InlineNotice>}
        </div>
      </CardBody>
    </Card>
  );
}
