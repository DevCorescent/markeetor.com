import { requirePage } from '@/server/page';
import { Announcements } from './announcements';

export const metadata = { title: 'Announcements' };

export default async function AnnouncementsPage() {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'notifications.broadcast' });
  return <Announcements canPricing={ctx.permissions.has('marketplace.manage')} />;
}
