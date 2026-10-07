import { CampaignDetail } from '@/components/email/campaign-detail';
import { requirePage } from '@/server/page';

export const metadata = { title: 'Campaign' };

export default async function Page(props: PageProps<'/app/email/campaigns/[id]'>) {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'] });
  const { id } = await props.params;
  return <CampaignDetail base="/app" id={id} canSend={ctx.permissions.has('crm.email.send')} />;
}
