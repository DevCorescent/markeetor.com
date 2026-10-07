import { CampaignDetail } from '@/components/email/campaign-detail';
import { requirePage } from '@/server/page';

export const metadata = { title: 'Campaign' };

export default async function Page(props: PageProps<'/admin/email/campaigns/[id]'>) {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: ['email.send', 'email.manage'] });
  const { id } = await props.params;
  return <CampaignDetail base="/admin" id={id} canSend={ctx.permissions.has('email.send')} />;
}
