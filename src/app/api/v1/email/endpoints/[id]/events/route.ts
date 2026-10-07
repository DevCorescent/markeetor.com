import { z } from 'zod';
import { idParam, paginationQuery, route } from '@/server/api';
import { listEndpointEvents } from '@/server/services/endpoints';

export const GET = route({ perm: 'email.manage', query: paginationQuery.extend({ status: z.string().max(20).optional() }) }, async ({ ctx, params, query }) => listEndpointEvents(ctx, idParam(params), query));
