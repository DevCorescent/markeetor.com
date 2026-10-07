import { requirePage } from '@/server/page';
import { OrgList } from './org-list';

export const metadata = { title: 'Organizations' };

export default async function OrgsPage() {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'orgs.read' });
  return <OrgList canCreate={ctx.permissions.has('orgs.create')} />;
}
