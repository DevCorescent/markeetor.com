import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { cancelScheduledBatch } from '@/server/services/distribution';

export const POST = route({ perm: 'distribution.create', body: z.object({ reason: z.string().trim().min(3).max(300) }) }, async ({ ctx, params, body }) => cancelScheduledBatch(ctx, idParam(params), body.reason));
