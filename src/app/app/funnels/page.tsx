import { NotAvailable } from '@/components/ui/states';
import { requirePage } from '@/server/page';
import { orgSettings } from '@/server/services/organizations';
import { FunnelsList } from './funnels-list';

export const metadata = { title: 'Funnels' };

export default async function FunnelsPage() {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: ['crm.funnels.manage', 'crm.leads.read_all'] });
  if (orgSettings(ctx.org?.settings).features.funnels === false) return <NotAvailable feature="Funnels" />;
  return <FunnelsList canManage={ctx.permissions.has('crm.funnels.manage')} />;
}
