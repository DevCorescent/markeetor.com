import { requirePage } from '@/server/page';
import { BatchDetail } from './batch-detail';

export const metadata = { title: 'Distribution batch' };

export default async function BatchPage(props: PageProps<'/admin/distribution/batches/[id]'>) {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'distribution.read' });
  const { id } = await props.params;
  return <BatchDetail id={id} canRollback={ctx.permissions.has('distribution.rollback')} canForce={ctx.role.rank >= 90} canCancel={ctx.permissions.has('distribution.create')} />;
}
