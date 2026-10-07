import { NotAvailable } from '@/components/ui/states';
import { requirePage } from '@/server/page';
import { orgSettings } from '@/server/services/organizations';
import { FunnelDetail } from './funnel-detail';

export const metadata = { title: 'Funnel' };

export default async function FunnelPage(props: PageProps<'/app/funnels/[id]'>) {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: ['crm.funnels.manage', 'crm.leads.read_all'] });
  if (orgSettings(ctx.org?.settings).features.funnels === false) return <NotAvailable feature="Funnels" />;
  const { id } = await props.params;
  const p = (k: string) => ctx.permissions.has(k);
  return <FunnelDetail id={id} canManage={p('crm.funnels.manage')} canEmail={p('crm.email.send') && orgSettings(ctx.org?.settings).features.email} />;
}
