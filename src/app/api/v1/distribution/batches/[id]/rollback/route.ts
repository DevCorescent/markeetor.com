import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { rollbackBatch } from '@/server/services/distribution';

export const POST = route(
  { perm: 'distribution.rollback', stepUp: true, body: z.object({ reason: z.string().trim().min(5).max(300), force: z.boolean().default(false) }) },
  async ({ ctx, params, body }) => rollbackBatch(ctx, idParam(params), body.reason, body.force),
);
