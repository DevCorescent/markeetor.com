import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { rejectCreditRequest } from '@/server/services/credits';

export const POST = route({ perm: 'marketplace.manage', body: z.object({ reason: z.string().trim().min(3).max(500) }) }, async ({ ctx, params, body }) => rejectCreditRequest(ctx, idParam(params), body.reason));
