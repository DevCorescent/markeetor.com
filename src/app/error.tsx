'use client';
import { ErrorState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="py-16">
      <ErrorState
        title="Something went wrong"
        description={`The error has been logged${error.digest ? ` (reference ${error.digest})` : ''}. Try again, or contact support if it persists.`}
        action={<Button onClick={reset}>Try again</Button>}
      />
    </div>
  );
}
