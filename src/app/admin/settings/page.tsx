import { requirePage } from '@/server/page';
import { PlatformSettings } from './platform-settings';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: ['system.manage', 'security.manage', 'audit.admin'] });
  const p = (k: string) => ctx.permissions.has(k);
  return <PlatformSettings perms={{ system: p('system.manage'), security: p('security.manage'), audit: p('audit.admin') }} isProd={process.env.NODE_ENV === 'production'} />;
}
