import { requirePage } from '@/server/page';
import { MarketplaceAdmin } from './marketplace-admin';

export const metadata = { title: 'Marketplace' };

export default async function MarketplaceAdminPage() {
  await requirePage({ scope: 'PLATFORM', perm: 'marketplace.manage' });
  return <MarketplaceAdmin />;
}
