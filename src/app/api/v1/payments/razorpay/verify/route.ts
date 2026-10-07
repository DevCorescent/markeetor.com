import { z } from 'zod';
import { route } from '@/server/api';
import { verifyPayment } from '@/server/services/payments';

export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.marketplace.request', body: z.object({ orderId: z.string().min(1).max(64), paymentId: z.string().min(1).max(64), signature: z.string().min(16).max(256) }) },
  async ({ ctx, body }) => verifyPayment(ctx, body),
);
