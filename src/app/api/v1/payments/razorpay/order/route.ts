import { z } from 'zod';
import { route } from '@/server/api';
import { createPaymentOrder } from '@/server/services/payments';

export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.marketplace.request', body: z.object({ creditRequestId: z.string().min(1).max(64) }), rate: { bucket: 'pay-order', limit: 30, windowSec: 3600, by: 'org' } },
  async ({ ctx, body }) => createPaymentOrder(ctx, body.creditRequestId),
);
