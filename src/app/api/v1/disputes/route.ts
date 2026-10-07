import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { listDisputes } from '@/server/services/disputes';

export const GET = route(
  { scope: 'ANY', perm: ['marketplace.manage', 'crm.billing.view', 'crm.marketplace.request'], query: paginationQuery.extend({ status: z.enum(['OPEN', 'APPROVED', 'REJECTED']).optional() }) },
  async ({ ctx, query }) => listDisputes(ctx, query),
);
