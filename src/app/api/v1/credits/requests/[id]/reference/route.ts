import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { submitPaymentReference } from '@/server/services/credits';

/** The client reports how they paid (UTR / transaction id). */
export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.marketplace.request', body: z.object({ reference: z.string().trim().min(3).max(120) }) },
  async ({ ctx, params, body }) => submitPaymentReference(ctx, idParam(params), body.reference),
);
