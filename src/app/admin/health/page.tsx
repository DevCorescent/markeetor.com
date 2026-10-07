import { requirePage } from '@/server/page';
import { HealthView } from './health-view';

export const metadata = { title: 'Client health' };

export default async function HealthPage() {
  await requirePage({ scope: 'PLATFORM', perm: 'orgs.read' });
  return <HealthView />;
}
