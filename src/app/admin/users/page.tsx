import { PageHeader } from '@/components/ui/page';
import { requirePage } from '@/server/page';
import { UsersTabs } from './users-tabs';

export const metadata = { title: 'Users' };

export default async function UsersPage() {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'users.read' });
  return (
    <>
      <PageHeader title="Users" description="Platform staff and client workspace users. Sessions, MFA, lockouts and login history." />
      <UsersTabs canInvite={ctx.permissions.has('users.invite')} />
    </>
  );
}
