import { route } from '@/server/api';
import { broadcastInput, createBroadcast, listBroadcasts } from '@/server/services/marketing';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'] }, async ({ ctx }) => ({ rows: await listBroadcasts(ctx) }));
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.email.manage', body: broadcastInput, rate: { bucket: 'broadcast', limit: 20, windowSec: 3600, by: 'org' } }, async ({ ctx, body }) => createBroadcast(ctx, body));
