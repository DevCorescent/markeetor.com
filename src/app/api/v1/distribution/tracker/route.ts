import { z } from 'zod';
import { parseFilterParam, sortSchema } from '@/lib/filters';
import { paginationQuery, route } from '@/server/api';
import { distributionTracker } from '@/server/services/distribution-insights';

export const GET = route(
  { perm: 'distribution.read', query: paginationQuery.extend({ filter: z.string().max(10_000).optional(), sort: z.string().max(200).optional(), includeNever: z.enum(['1', '0']).optional() }) },
  async ({ query }) => {
    let sort = null;
    try {
      sort = query.sort ? sortSchema.parse(JSON.parse(query.sort)) : null;
    } catch {}
    return distributionTracker({ filter: parseFilterParam(query.filter), sort, page: query.page, pageSize: query.pageSize, includeNever: query.includeNever === '1' });
  },
);
