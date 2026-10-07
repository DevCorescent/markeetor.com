import { requirePage } from '@/server/page';
import { AlertDetail } from './alert-detail';

export const metadata = { title: 'Security alert' };

export default async function AlertPage(props: PageProps<'/admin/security/alerts/[id]'>) {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'security.read' });
  const { id } = await props.params;
  return <AlertDetail id={id} canManage={ctx.permissions.has('security.manage')} selfId={ctx.user.id} canUsers={ctx.permissions.has('users.read')} />;
}
