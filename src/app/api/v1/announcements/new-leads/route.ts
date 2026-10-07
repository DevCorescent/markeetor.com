import { route } from '@/server/api';
import { announceNewLeads } from '@/server/services/announcements';

/** "Announce now": sends the new-leads announcement immediately instead of waiting for the scheduler. */
export const POST = route({ perm: 'notifications.broadcast' }, async () => ({ announcement: await announceNewLeads({ force: true }) }));
