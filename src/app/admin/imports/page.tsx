import { requirePage } from '@/server/page';
import { ImportCenter } from './import-center';

export const metadata = { title: 'Imports' };

export default async function ImportsPage() {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'imports.read' });
  return <ImportCenter canCreate={ctx.permissions.has('imports.create')} />;
}
