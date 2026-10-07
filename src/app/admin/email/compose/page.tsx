import { ComposePage } from '@/components/email/compose';
import { requirePage } from '@/server/page';

export const metadata = { title: 'New campaign' };

export default async function Page() {
  await requirePage({ scope: 'PLATFORM', perm: 'email.send' });
  return <ComposePage base="/admin" workspace={false} />;
}
