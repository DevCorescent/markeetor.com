import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { broadcast, broadcastInput, listAnnouncements } from '@/server/services/announcements';

export const GET = route({ perm: 'notifications.broadcast', query: paginationQuery.extend({ kind: z.enum(['MANUAL', 'NEW_LEADS']).optional() }) }, async ({ query }) => listAnnouncements(query));
export const POST = route({ perm: 'notifications.broadcast', body: broadcastInput, rate: { bucket: 'broadcast', limit: 30, windowSec: 3600 } }, async ({ ctx, body }) => broadcast(ctx, body));
