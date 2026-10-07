import { requirePage } from '@/server/page';
import { WorkspaceSettings } from './workspace-settings';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: ['crm.settings.manage', 'crm.users.manage', 'crm.roles.manage', 'crm.pipeline.manage', 'crm.comms.templates', 'crm.audit.read'] });
  const p = (k: string) => ctx.permissions.has(k);
  return <WorkspaceSettings perms={{ settings: p('crm.settings.manage'), roles: p('crm.roles.manage'), users: p('crm.users.manage'), pipeline: p('crm.pipeline.manage'), templates: p('crm.comms.templates'), audit: p('crm.audit.read') }} />;
}
