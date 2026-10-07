import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="font-mono text-[11px] tracking-[0.2em] text-subtle">404</div>
      <h1 className="text-xl">Page not found</h1>
      <p className="max-w-sm text-[12.5px] text-muted">The page doesn’t exist, or you don’t have access to the record it refers to.</p>
      <Link href="/" className="mt-2 text-xs text-fg-2 underline underline-offset-4">Go to your workspace</Link>
    </div>
  );
}
