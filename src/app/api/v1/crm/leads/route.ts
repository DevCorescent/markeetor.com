import { z } from 'zod';
import { parseFilterParam, sortSchema } from '@/lib/filters';
import { paginationQuery, route } from '@/server/api';
import { listClientLeads } from '@/server/services/crm';

/**
 * Paginated, masked lead list. There is intentionally no export/bulk-download endpoint for workspaces;
 * page size is capped and listing throughput is rate limited per user and per tenant.
 */
export const GET = route(
  {
    scope: 'ORGANIZATION',
    perm: ['crm.leads.read_all', 'crm.leads.read_own'],
    query: paginationQuery.extend({
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
      filter: z.string().max(10_000).optional(),
      view: z.enum(['active', 'archived', 'unassigned']).default('active'),
      sort: z.string().max(200).optional(),
    }),
    rate: { bucket: 'crm-list', limit: 120, windowSec: 60 },
  },
  async ({ ctx, query }) => {
    let sort = null;
    try {
      sort = query.sort ? sortSchema.parse(JSON.parse(query.sort)) : null;
    } catch {}
    return listClientLeads(ctx, { filter: parseFilterParam(query.filter), view: query.view, sort, page: query.page, pageSize: query.pageSize });
  },
);
