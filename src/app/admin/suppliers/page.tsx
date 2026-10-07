import { requirePage } from '@/server/page';
import { SuppliersView } from './suppliers-view';

export const metadata = { title: 'Suppliers' };

export default async function SuppliersPage() {
  await requirePage({ scope: 'PLATFORM', perm: 'marketplace.manage' });
  return <SuppliersView />;
}
