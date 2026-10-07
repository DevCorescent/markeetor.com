import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { revealClientField } from '@/server/services/crm';

export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.leads.reveal', body: z.object({ field: z.enum(['email', 'phone', 'secondaryPhone']), reason: z.string().trim().max(300).optional() }) },
  async ({ ctx, params, body }) => revealClientField(ctx, idParam(params), body.field, body.reason),
);
