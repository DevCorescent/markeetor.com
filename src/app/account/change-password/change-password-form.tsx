'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { InlineNotice } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';

export function ChangePasswordForm({ home }: { home: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <CardBody>
        <form
          className="grid max-w-md gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (next !== confirm) return setError('The new passwords do not match');
            setBusy(true);
            setError(null);
            try {
              await api('/api/v1/auth/password', { body: { currentPassword: current, newPassword: next } });
              window.location.href = home;
            } catch (err) {
              setError(errorMessage(err));
              setBusy(false);
            }
          }}
        >
          <Field label="Temporary password" hint="The one from your welcome email."><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></Field>
          <Field label="New password" hint="At least 12 characters; mix three of lowercase, uppercase, digits, symbols."><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required /></Field>
          <Field label="Confirm new password"><Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></Field>
          {error && <InlineNotice tone="danger">{error}</InlineNotice>}
          <div><Button type="submit" variant="primary" loading={busy}>Save and continue</Button></div>
        </form>
      </CardBody>
    </Card>
  );
}
