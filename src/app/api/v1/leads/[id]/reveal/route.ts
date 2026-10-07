import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { revealLeadField } from '@/server/services/leads';

export const POST = route(
  { perm: 'leads.reveal', body: z.object({ field: z.enum(['email', 'phone', 'secondaryPhone']), reason: z.string().trim().max(300).optional() }) },
  async ({ ctx, params, body }) => revealLeadField(ctx, idParam(params), body.field, body.reason),
);
