import { z } from 'zod';
import { route } from '@/server/api';
import { quoteRequest, requestSelectionSchema } from '@/server/services/marketplace';

export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.marketplace.request', body: z.object({ selection: requestSelectionSchema, couponCode: z.string().trim().max(32).optional() }), rate: { bucket: 'market-quote', limit: 120, windowSec: 60 } },
  async ({ ctx, body }) => quoteRequest(ctx, body.selection, body.couponCode),
);
