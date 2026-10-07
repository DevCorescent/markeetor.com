import { requirePage } from '@/server/page';
import { PlatformAnalytics } from './platform-analytics';

export const metadata = { title: 'Analytics' };

export default async function AnalyticsPage() {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'analytics.read' });
  return <PlatformAnalytics canExport={ctx.permissions.has('analytics.export')} />;
}
