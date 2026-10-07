import { z } from 'zod';
import { idParam, paginationQuery, route } from '@/server/api';
import { listBatchItems } from '@/server/services/distribution';

export const GET = route({ perm: 'distribution.read', query: paginationQuery.extend({ status: z.enum(['PENDING', 'ASSIGNED', 'SKIPPED', 'FAILED', 'ROLLED_BACK']).optional() }) }, async ({ params, query }) => listBatchItems(idParam(params), query));
