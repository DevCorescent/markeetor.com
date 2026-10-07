import { z } from 'zod';
import { route } from '@/server/api';
import { creditOverview } from '@/server/services/credits';

export const GET = route({ perm: 'marketplace.manage', query: z.object({ q: z.string().max(100).optional() }) }, async ({ query }) => creditOverview(query));
