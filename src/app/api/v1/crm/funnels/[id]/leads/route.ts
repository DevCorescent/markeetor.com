import { z } from 'zod';
import { idParam, paginationQuery, route } from '@/server/api';
import { stageLeads } from '@/server/services/funnels';

export const GET = route(
  { scope: 'ORGANIZATION', perm: ['crm.funnels.manage', 'crm.leads.read_all'], query: paginationQuery.extend({ stageId: z.string().max(40), scope: z.enum(['CURRENT', 'REACHED']).default('CURRENT') }) },
  async ({ ctx, params, query }) => stageLeads(ctx, idParam(params), query.stageId, query.scope, query.page, query.pageSize),
);
