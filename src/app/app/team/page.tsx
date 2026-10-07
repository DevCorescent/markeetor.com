import { NotAvailable } from '@/components/ui/states';
import { requirePage } from '@/server/page';
import { orgSettings } from '@/server/services/organizations';
import { TeamView } from './team-view';

export const metadata = { title: 'Team' };

export default async function TeamPage() {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: ['crm.team.read', 'crm.users.manage'] });
  if (!orgSettings(ctx.org?.settings).features.teams) return <NotAvailable feature="Team management" />;
  const p = (k: string) => ctx.permissions.has(k);
  return <TeamView selfId={ctx.user.id} orgId={ctx.orgId!} perms={{ manage: p('crm.team.manage'), users: p('crm.users.manage') }} />;
}
