import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { audienceSize } from '@/server/services/funnels';

export const GET = route(
  { scope: 'ORGANIZATION', perm: 'crm.funnels.manage', query: z.object({ stageId: z.string().max(40), scope: z.enum(['CURRENT', 'REACHED']).default('CURRENT') }) },
  async ({ ctx, params, query }) => audienceSize(ctx, idParam(params), query.stageId, query.scope),
);
