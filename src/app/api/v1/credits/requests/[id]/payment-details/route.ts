import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { sendPaymentDetails } from '@/server/services/credits';

export const POST = route(
  { perm: 'marketplace.manage', body: z.object({ details: z.string().trim().min(3).max(2000) }) },
  async ({ ctx, params, body }) => sendPaymentDetails(ctx, idParam(params), body.details),
);
