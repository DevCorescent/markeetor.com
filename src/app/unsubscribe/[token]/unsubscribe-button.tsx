'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function UnsubscribeButton({ token }: { token: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  if (state === 'done') return <p className="mt-5 text-[12.5px] text-fg-2">You’ve been unsubscribed. It may take a moment for campaigns already in flight to stop.</p>;
  return (
    <div className="mt-5 flex flex-col items-center gap-2">
      <Button variant="primary" loading={state === 'busy'} onClick={async () => {
        setState('busy');
        const r = await fetch(`/api/v1/email/unsubscribe/${token}`, { method: 'POST' });
        setState(r.ok ? 'done' : 'error');
      }}>Unsubscribe</Button>
      {state === 'error' && <p className="text-xs text-danger">Something went wrong. Please try again.</p>}
    </div>
  );
}
