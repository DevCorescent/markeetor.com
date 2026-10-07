'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { InlineNotice } from '@/components/ui/states';
import { AuthCard } from '../auth-card';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <AuthCard title="Reset password" description="We’ll email you a single-use link to set a new password.">
      {done ? (
        <div className="flex flex-col gap-4">
          <InlineNotice>{done}</InlineNotice>
          <Link href="/login" className="text-center text-xs text-subtle hover:text-fg">Back to sign in</Link>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const res = await api<{ message: string }>('/api/v1/auth/password/forgot', { body: { email } });
              setDone(res.message);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="h-9" />
          </Field>
          {error && <InlineNotice tone="danger">{error}</InlineNotice>}
          <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">Send reset link</Button>
          <Link href="/login" className="text-center text-xs text-subtle hover:text-fg">Back to sign in</Link>
        </form>
      )}
    </AuthCard>
  );
}
