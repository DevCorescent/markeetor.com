import { z } from 'zod';
import { route } from '@/server/api';
import { todayQueue } from '@/server/services/client-tools';

export const GET = route(
  { scope: 'ORGANIZATION', perm: ['crm.leads.read_all', 'crm.leads.read_own'], query: z.object({ mine: z.enum(['1', '0']).optional() }) },
  async ({ ctx, query }) => todayQueue(ctx, { mine: query.mine === '1' }),
);
