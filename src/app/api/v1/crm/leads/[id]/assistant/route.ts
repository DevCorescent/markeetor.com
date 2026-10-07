import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { leadAssistant } from '@/server/services/client-tools';

const perm = ['crm.leads.read_all', 'crm.leads.read_own'] as const;
export const GET = route({ scope: 'ORGANIZATION', perm: [...perm] }, async ({ ctx, params }) => leadAssistant(ctx, idParam(params)));
export const POST = route(
  { scope: 'ORGANIZATION', perm: [...perm], body: z.object({ draft: z.enum(['intro', 'followup', 'whatsapp']) }), rate: { bucket: 'lead-assistant', limit: 60, windowSec: 3600 } },
  async ({ ctx, params, body }) => leadAssistant(ctx, idParam(params), { draft: body.draft }),
);
