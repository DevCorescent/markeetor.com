import { BrandMark, logoText } from '@/components/shell/brand';
import { shellBranding } from '@/server/branding';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { mark } = await shellBranding();
  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="grid-backdrop pointer-events-none absolute inset-0" aria-hidden />
      <header className="relative flex h-16 items-center px-6">
        <div className="flex items-center gap-2.5">
          <BrandMark brand={mark} size={mark.logoUrl && !mark.showNameWithLogo ? 28 : 24} />
          {(!mark.logoUrl || mark.showNameWithLogo) && <span className="text-[13px] font-semibold tracking-[-0.02em]">{logoText(mark.productName)}</span>}
        </div>
      </header>
      <main className="relative flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-[380px]">{children}</div>
      </main>
      <footer className="relative pb-6 text-center text-[11px] text-subtle">Authorized use only. Sign-in activity is monitored and recorded.</footer>
    </div>
  );
}
