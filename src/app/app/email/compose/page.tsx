import { ComposePage } from '@/components/email/compose';
import { requirePage } from '@/server/page';

export const metadata = { title: 'New campaign' };

export default async function Page() {
  await requirePage({ scope: 'ORGANIZATION', perm: 'crm.email.send' });
  return <ComposePage base="/app" workspace={true} />;
}
