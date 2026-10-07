import { requirePage } from '@/server/page';
import { OrgDetail } from './org-detail';

export const metadata = { title: 'Organization' };

export default async function OrgPage(props: PageProps<'/admin/organizations/[id]'>) {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'orgs.read' });
  const { id } = await props.params;
  const p = (k: string) => ctx.permissions.has(k);
  return <OrgDetail id={id} perms={{ update: p('orgs.update'), status: p('orgs.status'), quotas: p('orgs.quotas'), invite: p('users.invite'), users: p('users.read'), distribution: p('distribution.read') }} />;
}
