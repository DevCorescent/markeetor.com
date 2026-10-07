import { requirePage } from '@/server/page';
import { getSetting } from '@/server/settings';
import { CommandCenter } from './command-center';

export const metadata = { title: 'Command center' };

export default async function AdminHome() {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'platform.dashboard.view' });
  const demo = (await getSetting('dashboard.demoDataLabel')).enabled && process.env.NODE_ENV !== 'production';
  return <CommandCenter name={ctx.user.name.split(' ')[0]} demo={demo} canSecurity={ctx.permissions.has('security.read')} canAudit={ctx.permissions.has('audit.read')} />;
}
