import { requirePage } from '@/server/page';
import { MarketingAdmin } from './marketing-admin';

export const metadata = { title: 'Marketing' };

export default async function MarketingAdminPage() {
  await requirePage({ scope: 'PLATFORM', perm: 'email.manage' });
  return <MarketingAdmin />;
}
