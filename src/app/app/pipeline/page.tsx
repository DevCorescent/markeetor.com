import { NotAvailable } from '@/components/ui/states';
import { requirePage } from '@/server/page';
import { orgSettings } from '@/server/services/organizations';
import { PipelineBoard } from './pipeline-board';

export const metadata = { title: 'Pipeline' };

export default async function PipelinePage() {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: ['crm.leads.read_all', 'crm.leads.read_own'] });
  if (!orgSettings(ctx.org?.settings).features.pipeline) return <NotAvailable feature="Pipeline" />;
  return <PipelineBoard canMove={ctx.permissions.has('crm.pipeline.move')} all={ctx.permissions.has('crm.leads.read_all')} canManage={ctx.permissions.has('crm.pipeline.manage')} />;
}
