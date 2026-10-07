import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { createCreditRequest, creditRequestInput, listCreditRequests } from '@/server/services/credits';

export const GET = route(
  { scope: 'ANY', perm: ['marketplace.manage', 'crm.billing.view'], query: paginationQuery.extend({ status: z.string().max(20).optional(), organizationId: z.string().max(64).optional() }) },
  async ({ ctx, query }) => listCreditRequests(ctx, query),
);
export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.marketplace.request', body: creditRequestInput, rate: { bucket: 'credit-request', limit: 20, windowSec: 3600, by: 'org' } },
  async ({ ctx, body }) => createCreditRequest(ctx, body),
);
