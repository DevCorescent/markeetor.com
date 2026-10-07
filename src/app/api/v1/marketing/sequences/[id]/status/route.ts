import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { setSequenceStatus } from '@/server/services/sequences';

export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.email.manage', body: z.object({ status: z.enum(['ACTIVE', 'PAUSED']) }) }, async ({ ctx, params, body }) => setSequenceStatus(ctx, idParam(params), body.status));
