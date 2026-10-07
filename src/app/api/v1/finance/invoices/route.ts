import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { listInvoices } from '@/server/services/finance';

export const GET = route(
  { scope: 'ANY', perm: ['marketplace.manage', 'crm.billing.view'], query: paginationQuery.extend({ organizationId: z.string().max(64).optional(), fy: z.string().max(9).optional() }) },
  async ({ ctx, query }) => listInvoices(ctx, query),
);
