'use client';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, registerStepUpHandler } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/overlay';
import { InlineNotice } from '@/components/ui/states';

/** Global identity re-verification for sensitive operations. API calls that return STEP_UP_REQUIRED open this dialog and retry on success. */
export function StepUpProvider({ mfaEnabled }: { mfaEnabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    registerStepUpHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setValue('');
          setError(null);
          setOpen(true);
        }),
    );
    return () => registerStepUpHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(false);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/auth/step-up', { body: mfaEnabled ? { code: value } : { password: value } });
      finish(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && finish(false)}
      title="Confirm it’s you"
      description="This action is sensitive. Re-verify your identity to continue."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!value} onClick={submit}>Verify</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-3">
        <Field label={mfaEnabled ? 'Authenticator code' : 'Password'} htmlFor="stepup">
          <Input
            id="stepup"
            autoFocus
            type={mfaEnabled ? 'text' : 'password'}
            inputMode={mfaEnabled ? 'numeric' : undefined}
            autoComplete={mfaEnabled ? 'one-time-code' : 'current-password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      </form>
    </Dialog>
  );
}
