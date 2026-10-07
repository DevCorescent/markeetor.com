import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { fulfillLeadRequest } from '@/server/services/marketplace';

export const POST = route({ perm: 'marketplace.manage', body: z.object({ note: z.string().trim().max(500).optional() }) }, async ({ ctx, params, body }) => fulfillLeadRequest(ctx, idParam(params), { note: body.note }));
