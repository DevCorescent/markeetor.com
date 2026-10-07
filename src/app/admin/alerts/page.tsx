import { requirePage } from '@/server/page';
import { AlertsView } from './alerts-view';

export const metadata = { title: 'Alert rules' };

export default async function AlertsPage() {
  await requirePage({ scope: 'PLATFORM', perm: 'marketplace.manage' });
  return <AlertsView />;
}
