import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { listCreditEntries } from '@/server/services/credits';

/** Credit history (the ledger). Clients see their own; platform staff can filter by workspace and type. */
export const GET = route(
  { scope: 'ANY', perm: ['marketplace.manage', 'crm.billing.view'], query: paginationQuery.extend({ organizationId: z.string().max(64).optional(), type: z.string().max(120).optional() }) },
  async ({ ctx, query }) => listCreditEntries(ctx, query),
);
