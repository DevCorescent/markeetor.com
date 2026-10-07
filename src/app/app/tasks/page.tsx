import { NotAvailable } from '@/components/ui/states';
import { requirePage } from '@/server/page';
import { orgSettings } from '@/server/services/organizations';
import { TasksView } from './tasks-view';

export const metadata = { title: 'Tasks' };

export default async function TasksPage() {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: ['crm.tasks.manage', 'crm.tasks.read_all'] });
  if (!orgSettings(ctx.org?.settings).features.tasks) return <NotAvailable feature="Tasks" />;
  return <TasksView selfId={ctx.user.id} team={ctx.permissions.has('crm.tasks.read_all')} canManage={ctx.permissions.has('crm.tasks.manage')} canDelegate={ctx.permissions.has('crm.tasks.read_all') || ctx.permissions.has('crm.team.manage')} />;
}
