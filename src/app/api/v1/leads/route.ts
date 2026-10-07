import { z } from 'zod';
import { parseFilterParam, sortSchema } from '@/lib/filters';
import { paginationQuery, route } from '@/server/api';
import { createLead, leadEditInput, listLeads } from '@/server/services/leads';

export const GET = route(
  {
    perm: 'leads.read',
    apiKey: true,
    query: paginationQuery.extend({
      filter: z.string().max(10_000).optional(),
      view: z.enum(['active', 'archived', 'all']).default('active'),
      sort: z.string().max(200).optional(),
    }),
    rate: { bucket: 'leads-list', limit: 240, windowSec: 60 },
  },
  async ({ query }) => {
    let sort = null;
    try {
      sort = query.sort ? sortSchema.parse(JSON.parse(query.sort)) : null;
    } catch {}
    return listLeads({ filter: parseFilterParam(query.filter), view: query.view, sort, page: query.page, pageSize: query.pageSize });
  },
);

export const POST = route({ perm: 'leads.update', body: leadEditInput.extend({ fullName: z.string().trim().min(1).max(200) }) }, async ({ ctx, body }) => createLead(ctx, body));
