import { requirePage } from '@/server/page';
import { ImportDetail } from './import-detail';

export const metadata = { title: 'Import' };

export default async function ImportPage(props: PageProps<'/admin/imports/[id]'>) {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'imports.read' });
  const { id } = await props.params;
  return <ImportDetail id={id} canCreate={ctx.permissions.has('imports.create')} canRollback={ctx.permissions.has('imports.rollback')} />;
}
