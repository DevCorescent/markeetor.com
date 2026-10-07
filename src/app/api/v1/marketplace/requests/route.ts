import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { createLeadRequest, leadRequestInput, listLeadRequests } from '@/server/services/marketplace';

export const GET = route(
  { scope: 'ANY', perm: ['marketplace.manage', 'crm.marketplace.view', 'crm.billing.view'], query: paginationQuery.extend({ status: z.string().max(20).optional(), billing: z.string().max(20).optional(), organizationId: z.string().max(64).optional() }) },
  async ({ ctx, query }) => listLeadRequests(ctx, query),
);
export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.marketplace.request', body: leadRequestInput, rate: { bucket: 'market-request', limit: 60, windowSec: 3600, by: 'org' } },
  async ({ ctx, body }) => createLeadRequest(ctx, body),
);
