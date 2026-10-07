'use client';
import { useState } from 'react';
import { Button } from './button';
import { Field, Input, Textarea } from './input';
import { Dialog } from './overlay';
import { InlineNotice } from './states';

/**
 * Confirmation workflow for destructive or large-scale actions.
 * `typed` forces the user to type a phrase; `requireReason` captures a justification for the audit log.
 */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', danger, typed, requireReason, onConfirm, children }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  typed?: string;
  requireReason?: boolean;
  onConfirm: (reason: string) => Promise<unknown> | void;
  children?: React.ReactNode;
}) {
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = (!typed || text.trim() === typed) && (!requireReason || reason.trim().length >= 3);

  const close = (o: boolean) => {
    if (!o) {
      setText('');
      setReason('');
      setError(null);
    }
    onOpenChange(o);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)} disabled={busy}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            disabled={!ready}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm(reason.trim());
                close(false);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Action failed');
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {children}
        {requireReason && (
          <Field label="Reason" hint="Recorded in the audit log.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this needed?" maxLength={500} />
          </Field>
        )}
        {typed && (
          <Field label={`Type “${typed}” to confirm`}>
            <Input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
          </Field>
        )}
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      </div>
    </Dialog>
  );
}
