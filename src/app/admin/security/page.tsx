import { requirePage } from '@/server/page';
import { SecurityCenter } from './security-center';

export const metadata = { title: 'Security center' };

export default async function SecurityPage() {
  await requirePage({ scope: 'PLATFORM', perm: 'security.read' });
  return <SecurityCenter />;
}
