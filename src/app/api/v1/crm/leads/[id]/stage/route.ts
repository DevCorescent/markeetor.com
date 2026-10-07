import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { moveStage } from '@/server/services/crm';

export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.pipeline.move', body: z.object({ stageId: z.string().max(64), lostReason: z.string().trim().max(300).nullable().optional() }) },
  async ({ ctx, params, body }) => moveStage(ctx, idParam(params), body.stageId, { lostReason: body.lostReason }),
);
