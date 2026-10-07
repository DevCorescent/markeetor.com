import { PageHeader } from '@/components/ui/page';
import { requirePage } from '@/server/page';
import { RolesEditor } from '@/components/data/roles-editor';

export const metadata = { title: 'Roles' };

export default async function RolesPage() {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'roles.read' });
  return (
    <>
      <PageHeader title="Roles & permissions" description="Authorization is evaluated against granular permissions, never role names. System roles are fixed; create custom roles for other combinations." />
      <RolesEditor endpoint="/api/v1/roles" canManage={ctx.permissions.has('roles.manage')} />
    </>
  );
}
