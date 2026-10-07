import { requirePage } from '@/server/page';
import { TodayView } from './today-view';

export const metadata = { title: 'Today' };

export default async function TodayPage() {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: ['crm.leads.read_all', 'crm.leads.read_own'] });
  // Formatted once on the server so the server and browser render the same text.
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' });
  return <TodayView team={ctx.permissions.has('crm.leads.read_all')} name={ctx.user.name.split(' ')[0]} date={date} />;
}
