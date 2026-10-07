import { z } from 'zod';
import { route } from '@/server/api';
import { quoteCreditPurchase } from '@/server/services/credits';

export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.marketplace.request', body: z.object({ packageId: z.string().max(40).optional(), credits: z.number().int().min(1).max(10_000_000).optional() }) },
  async ({ ctx, body }) => quoteCreditPurchase(ctx, body),
);
