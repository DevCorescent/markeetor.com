import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { setBillingStatus } from '@/server/services/marketplace';

export const POST = route(
  { perm: 'marketplace.manage', stepUp: true, body: z.object({ status: z.enum(['DUE', 'PAID', 'WAIVED', 'VOID']), note: z.string().trim().max(500).optional() }) },
  async ({ ctx, params, body }) => setBillingStatus(ctx, idParam(params), body.status, body.note),
);
