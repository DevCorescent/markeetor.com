import { requirePage } from '@/server/page';
import { UserDetail } from './user-detail';

export const metadata = { title: 'User' };

export default async function UserPage(props: PageProps<'/admin/users/[id]'>) {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'users.read' });
  const { id } = await props.params;
  const p = (k: string) => ctx.permissions.has(k);
  return <UserDetail id={id} selfId={ctx.user.id} perms={{ manage: p('users.manage'), sessions: p('users.sessions.revoke'), roles: p('roles.manage') }} />;
}
