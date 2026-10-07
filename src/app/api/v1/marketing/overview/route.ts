import { z } from 'zod';
import { route } from '@/server/api';
import { marketingOverview } from '@/server/services/marketing';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'], query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }, async ({ ctx, query }) => marketingOverview(ctx, query.days));
