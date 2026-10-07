import { ADMIN_NAV, visibleNav } from '@/components/shell/nav';
import { AppShell } from '@/components/shell/app-shell';
import { logoText } from '@/components/shell/brand';
import { shellBranding } from '@/server/branding';
import { requirePage } from '@/server/page';

/** Private area: never indexed, whatever the public SEO settings say. */
export const metadata = { robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: LayoutProps<'/admin'>) {
  const ctx = await requirePage({ scope: 'PLATFORM' });
  const { mark, allowThemeChoice } = await shellBranding();
  return (
    <AppShell
      nav={visibleNav(ADMIN_NAV, ctx.permissions)}
      home="/admin"
      brand={logoText(mark.productName)}
      sub={mark.tagline}
      mark={mark}
      showBrandText={!mark.logoUrl || mark.showNameWithLogo}
      allowThemeChoice={allowThemeChoice}
      user={{ name: ctx.user.name, email: ctx.user.email, mfaEnabled: ctx.user.mfaEnabled }}
      roleName={ctx.role.name}
      searchPlaceholder="Search leads, organizations, users…"
    >
      {children}
    </AppShell>
  );
}
