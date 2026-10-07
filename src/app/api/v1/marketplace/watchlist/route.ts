import { z } from 'zod';
import { route } from '@/server/api';
import { toggleWatch, watchedIds, watchlist } from '@/server/services/saved-searches';

export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.marketplace.view', query: z.object({ ids: z.string().optional() }) }, async ({ ctx, query }) => (query.ids ? { ids: await watchedIds(ctx) } : watchlist(ctx)));
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.marketplace.view', body: z.object({ leadId: z.string().min(1).max(64), on: z.boolean() }) }, async ({ ctx, body }) => toggleWatch(ctx, body.leadId, body.on));
