import { requirePage } from '@/server/page';
import { SystemView } from './system-view';

export const metadata = { title: 'System health' };

export default async function SystemPage() {
  await requirePage({ scope: 'PLATFORM', perm: 'system.manage' });
  return <SystemView />;
}
