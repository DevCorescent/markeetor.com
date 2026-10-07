import { requirePage } from '@/server/page';
import { FinanceView } from './finance-view';

export const metadata = { title: 'Finance' };

export default async function FinancePage() {
  await requirePage({ scope: 'PLATFORM', perm: 'marketplace.manage' });
  return <FinanceView />;
}
