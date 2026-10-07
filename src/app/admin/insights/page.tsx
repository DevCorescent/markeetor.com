import { requirePage } from '@/server/page';
import { InsightsView } from './insights-view';

export const metadata = { title: 'Insights' };

export default async function InsightsPage() {
  await requirePage({ scope: 'PLATFORM', perm: 'analytics.read' });
  return <InsightsView />;
}
