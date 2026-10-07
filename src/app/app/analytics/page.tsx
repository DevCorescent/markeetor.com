import { NotAvailable } from '@/components/ui/states';
import { requirePage } from '@/server/page';
import { orgSettings } from '@/server/services/organizations';
import { ClientAnalytics } from './client-analytics';

export const metadata = { title: 'Analytics' };

export default async function AnalyticsPage() {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: 'crm.analytics.read' });
  if (!orgSettings(ctx.org?.settings).features.analytics) return <NotAvailable feature="Analytics" />;
  return <ClientAnalytics />;
}
