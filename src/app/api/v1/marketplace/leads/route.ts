import { z } from 'zod';
import { parseFilterParam, sortSchema } from '@/lib/filters';
import { paginationQuery, route } from '@/server/api';
import { listCatalog } from '@/server/services/marketplace';

/** Masked catalog of available leads. No names, companies or contact details ever leave this endpoint. */
export const GET = route(
  { scope: 'ANY', perm: ['crm.marketplace.view', 'marketplace.manage'], query: paginationQuery.extend({ filter: z.string().max(10_000).optional(), sort: z.string().max(200).optional() }), rate: { bucket: 'market-list', limit: 180, windowSec: 60 } },
  async ({ ctx, query }) => {
    let sort = null;
    try { sort = query.sort ? sortSchema.parse(JSON.parse(query.sort)) : null; } catch {}
    return listCatalog(ctx, { filter: parseFilterParam(query.filter), sort, page: query.page, pageSize: query.pageSize });
  },
);
