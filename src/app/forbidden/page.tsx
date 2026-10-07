import Link from 'next/link';
import { Lock } from 'lucide-react';

export const metadata = { title: 'Access denied' };

export default async function Forbidden(props: PageProps<'/forbidden'>) {
  const sp = await props.searchParams;
  const back = sp.from === 'app' ? '/app' : sp.from === 'admin' ? '/admin' : '/';
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="grid size-10 place-items-center rounded-md border border-border-strong bg-surface-2"><Lock className="size-4 text-muted" /></div>
      <h1 className="text-xl">You don’t have access to this page</h1>
      <p className="max-w-sm text-[12.5px] text-muted">Your role does not include the permission required. If you believe this is a mistake, contact your administrator. This attempt has been recorded.</p>
      <Link href={back} className="mt-2 text-xs text-fg-2 underline underline-offset-4">Return to your workspace</Link>
    </div>
  );
}
