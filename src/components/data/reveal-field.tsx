'use client';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Dialog, Tooltip } from '@/components/ui/overlay';

/**
 * Shows a masked value with a reveal control. Revealing calls an audited endpoint; the raw value lives
 * only in component state and is cleared after 60 seconds or when hidden.
 */
export function RevealField({ masked, has, endpoint, field, canReveal, requireReason }: { masked: string | null; has: boolean; endpoint: string; field: 'email' | 'phone' | 'secondaryPhone'; canReveal: boolean; requireReason?: boolean }) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(false);
  const [reason, setReason] = useState('');
  if (!has) return <span className="text-subtle">—</span>;
  const reveal = async (r?: string) => {
    setBusy(true);
    try {
      const res = await api<{ value: string }>(endpoint, { body: { field, reason: r || undefined } });
      setValue(res.value);
      setTimeout(() => setValue(null), 60_000);
      setAsk(false);
      setReason('');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <span className={`truncate font-mono text-[12px] ${value ? 'text-fg' : 'text-muted'}`}>{value ?? masked}</span>
      {canReveal && (
        <Tooltip content={value ? 'Hide' : 'Reveal (recorded in the audit log)'}>
          <button
            className="rounded p-0.5 text-subtle hover:bg-surface-3 hover:text-fg disabled:opacity-40"
            aria-label={value ? `Hide ${field}` : `Reveal ${field}`}
            disabled={busy}
            onClick={() => (value ? setValue(null) : requireReason ? setAsk(true) : reveal())}
          >
            {value ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        </Tooltip>
      )}
      <Dialog open={ask} onOpenChange={setAsk} title="Reason for reveal" description="Your workspace requires a reason to view contact details." size="sm" footer={<><Button variant="ghost" onClick={() => setAsk(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={reason.trim().length < 3} onClick={() => reveal(reason.trim())}>Reveal</Button></>}>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Calling to schedule a demo" autoFocus /></Field>
      </Dialog>
    </span>
  );
}
