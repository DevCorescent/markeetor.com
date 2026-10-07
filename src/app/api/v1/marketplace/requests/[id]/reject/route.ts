import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { rejectLeadRequest } from '@/server/services/marketplace';

export const POST = route({ perm: 'marketplace.manage', body: z.object({ reason: z.string().trim().min(3).max(500) }) }, async ({ ctx, params, body }) => rejectLeadRequest(ctx, idParam(params), body.reason));
