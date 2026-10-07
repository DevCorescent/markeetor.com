import { MarketingApp } from '@/components/marketing/marketing-app';
import { requirePage } from '@/server/page';

export const metadata = { title: 'Marketing' };

export default async function MarketingPage() {
  await requirePage({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'] });
  return <MarketingApp />;
}
