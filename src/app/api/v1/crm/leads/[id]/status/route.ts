import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { setClientStatus } from '@/server/services/crm';

export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.leads.update', body: z.object({ status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'NEGOTIATION', 'CONVERTED', 'LOST']), lostReason: z.string().trim().max(300).nullable().optional() }) },
  async ({ ctx, params, body }) => setClientStatus(ctx, idParam(params), body.status, body.lostReason),
);
