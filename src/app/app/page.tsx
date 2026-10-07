import { requirePage } from '@/server/page';
import { orgSettings } from '@/server/services/organizations';
import { ClientDashboard } from './client-dashboard';

export const metadata = { title: 'Dashboard' };

export default async function AppHome() {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: 'crm.dashboard.view' });
  // Free leads delivered from the visitor's homepage search: shown for two weeks.
  const ob = (ctx.org?.settings as { onboarding?: { welcome?: { status?: string; count?: number; at?: string }; leadInterests?: { summary?: string } | null } } | null)?.onboarding;
  const w = ob?.welcome;
  const welcome = w?.at && w.status && (w.count ?? 0) > 0 && Date.now() - new Date(w.at).getTime() < 14 * 86_400_000 ? { status: w.status, count: w.count ?? 0, at: w.at, summary: ob?.leadInterests?.summary ?? null } : null;
  return <ClientDashboard name={ctx.user.name.split(' ')[0]} own={!ctx.permissions.has('crm.leads.read_all')} market={ctx.permissions.has('crm.marketplace.view') && orgSettings(ctx.org?.settings).features.marketplace !== false} welcome={welcome} />;
}
