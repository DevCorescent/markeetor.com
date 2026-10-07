import { requirePage } from '@/server/page';
import { RoiView } from './roi-view';

export const metadata = { title: 'Lead ROI' };

export default async function RoiPage() {
  await requirePage({ scope: 'ORGANIZATION', perm: ['crm.analytics.read', 'crm.dashboard.view'] });
  return <RoiView />;
}
