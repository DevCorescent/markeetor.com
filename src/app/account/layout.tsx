import { redirect } from 'next/navigation';
import { ADMIN_NAV, APP_NAV, visibleNav } from '@/components/shell/nav';
import { AppShell } from '@/components/shell/app-shell';
import { logoText } from '@/components/shell/brand';
import { shellBranding } from '@/server/branding';
import { currentContext } from '@/server/page';
import { orgSettings } from '@/server/services/organizations';

export const metadata = { robots: { index: false, follow: false } };

export default async function AccountLayout({ children }: LayoutProps<'/account'>) {
  const ctx = await currentContext();
  if (!ctx) redirect('/login');
  if (ctx.session?.mfaPending) redirect('/login/mfa');
  const platform = ctx.scope === 'PLATFORM';
  const { mark, allowThemeChoice } = await shellBranding();
  const settings = orgSettings(ctx.org?.settings);
  // While MFA enrollment is outstanding, hide navigation so the user completes setup first.
  const nav = ctx.restriction ? [] : platform ? visibleNav(ADMIN_NAV, ctx.permissions) : visibleNav(APP_NAV, ctx.permissions, settings.features);
  return (
    <AppShell
      nav={nav}
      home={platform ? '/admin' : '/app'}
      brand={platform ? logoText(mark.productName) : (ctx.org?.name ?? 'Workspace')}
      sub={platform ? mark.tagline : (ctx.org?.code ?? '')}
      mark={mark}
      showBrandText={!platform || !mark.logoUrl || mark.showNameWithLogo}
      allowThemeChoice={allowThemeChoice}
      user={{ name: ctx.user.name, email: ctx.user.email, mfaEnabled: ctx.user.mfaEnabled }}
      restricted={Boolean(ctx.restriction)}
      roleName={ctx.role.name}
      searchPlaceholder={platform ? 'Search leads, organizations, users…' : 'Search your leads…'}
    >
      <div className="mx-auto max-w-4xl">{children}</div>
    </AppShell>
  );
}
