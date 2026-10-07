import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { recordConsent } from '@/server/services/crm';

export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.comms.log', body: z.object({ channel: z.enum(['CALL', 'EMAIL', 'SMS', 'WHATSAPP', 'MEETING']), status: z.enum(['OPTED_IN', 'OPTED_OUT']), source: z.string().trim().max(120).nullable().optional(), note: z.string().trim().max(500).nullable().optional() }) },
  async ({ ctx, params, body }) => recordConsent(ctx, idParam(params), body),
);
