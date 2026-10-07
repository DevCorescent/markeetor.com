import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { generateDkim, setDkim } from '@/server/services/deliverability';

export const POST = route(
  { scope: 'ANY', perm: ['email.manage', 'crm.email.manage'], body: z.object({ action: z.enum(['generate', 'enable', 'disable']) }), rate: { bucket: 'dkim', limit: 30, windowSec: 3600 } },
  async ({ ctx, params, body }) => {
    const id = idParam(params);
    if (body.action === 'generate') return { record: await generateDkim(ctx, id) };
    return setDkim(ctx, id, body.action === 'enable');
  },
);
