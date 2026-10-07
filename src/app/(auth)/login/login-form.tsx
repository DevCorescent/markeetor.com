'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { InlineNotice } from '@/components/ui/states';

export function LoginForm({ initialError }: { initialError: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const res = await api<{ redirect: string }>('/api/v1/auth/login', { body: { email, password } });
          const next = new URLSearchParams(window.location.search).get('next');
          window.location.href = res.redirect === '/login/mfa' ? '/login/mfa' : next && next.startsWith('/') && !next.startsWith('//') ? next : res.redirect;
        } catch (err) {
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <Field label="Email" htmlFor="email">
        <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="h-9" />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="h-9" />
      </Field>
      {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1 w-full">Continue</Button>
      <Link href="/forgot-password" className="text-center text-xs text-subtle hover:text-fg">Forgot your password?</Link>
    </form>
  );
}
