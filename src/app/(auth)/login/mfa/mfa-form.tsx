'use client';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { InlineNotice } from '@/components/ui/states';

export function MfaForm() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const res = await api<{ redirect: string }>('/api/v1/auth/mfa/verify', { body: { code } });
          window.location.href = res.redirect;
        } catch (err) {
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <Field label="Verification code" htmlFor="code">
        <Input id="code" autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="h-10 text-center font-mono text-lg tracking-[0.4em]" maxLength={10} />
      </Field>
      {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      <Button type="submit" variant="primary" size="lg" loading={busy} disabled={code.length < 6} className="w-full">Verify</Button>
      <button type="button" className="text-center text-xs text-subtle hover:text-fg" onClick={async () => { await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => null); window.location.href = '/login'; }}>
        Use a different account
      </button>
    </form>
  );
}
