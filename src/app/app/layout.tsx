import { APP_NAV, visibleNav } from '@/components/shell/nav';
import { AppShell } from '@/components/shell/app-shell';
import { shellBranding } from '@/server/branding';
import { requirePage } from '@/server/page';
import { LeadFinderLauncher } from '@/components/marketplace/lead-finder';
import { orgSettings } from '@/server/services/organizations';

/** Private area: never indexed, whatever the public SEO settings say. */
export const metadata = { robots: { index: false, follow: false } };

export default async function ClientLayout({ children }: LayoutProps<'/app'>) {
  const ctx = await requirePage({ scope: 'ORGANIZATION' });
  const settings = orgSettings(ctx.org?.settings);
  const { mark, allowThemeChoice } = await shellBranding();
  return (
    <AppShell
      nav={visibleNav(APP_NAV, ctx.permissions, settings.features)}
      home="/app"
      brand={ctx.org?.name ?? 'Workspace'}
      sub={ctx.org?.code ?? ''}
      mark={mark}
      allowThemeChoice={allowThemeChoice}
      user={{ name: ctx.user.name, email: ctx.user.email, mfaEnabled: ctx.user.mfaEnabled }}
      roleName={ctx.role.name}
      searchPlaceholder="Search your leads…"
      watermark={settings.security.watermark ? `${ctx.user.email} · ${ctx.ip ?? ''}` : null}
    >
      {children}
      {ctx.permissions.has('crm.marketplace.view') && settings.features.marketplace !== false && <LeadFinderLauncher canRequest={ctx.permissions.has('crm.marketplace.request')} />}
    </AppShell>
  );
}
