import { requirePage } from '@/server/page';
import { Automation } from './automation';

export const metadata = { title: 'Automation' };

export default async function AutomationPage() {
  await requirePage({ scope: 'PLATFORM', perm: 'automation.manage' });
  return <Automation />;
}
