import { z } from 'zod';
import { route } from '@/server/api';
import { gstSummary } from '@/server/services/finance';

export const GET = route({ perm: 'marketplace.manage', query: z.object({ fy: z.string().regex(/^\d{4}(-\d{2})?$/) }) }, async ({ query }) => ({ months: await gstSummary(query.fy) }));
