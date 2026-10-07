'use client';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { InlineNotice } from '@/components/ui/states';

export function PasswordRules() {
  return <p className="text-[11.5px] leading-relaxed text-subtle">At least 12 characters, mixing three of: lowercase, uppercase, digits, symbols. Avoid your name or email.</p>;
}

export function SetPasswordForm({ endpoint, extra, submitLabel, withName, defaultName, onDone }: {
  endpoint: string; extra: Record<string, string>; submitLabel: string; withName?: boolean; defaultName?: string; onDone: (res: unknown) => void;
}) {
  const [name, setName] = useState(defaultName ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (password !== confirm) return setError('Passwords do not match');
        setBusy(true);
        setError(null);
        try {
          const res = await api(endpoint, { body: { ...extra, password, ...(withName ? { name } : {}) } });
          onDone(res);
        } catch (err) {
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      {withName && (
        <Field label="Full name" htmlFor="name">
          <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} className="h-9" autoComplete="name" />
        </Field>
      )}
      <Field label="New password" htmlFor="pw">
        <Input id="pw" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="h-9" autoComplete="new-password" />
      </Field>
      <Field label="Confirm password" htmlFor="pw2">
        <Input id="pw2" type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-9" autoComplete="new-password" />
      </Field>
      <PasswordRules />
      {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">{submitLabel}</Button>
    </form>
  );
}
