import { z } from 'zod';
import { conditionSchema } from '@/lib/filters';
import { route } from '@/server/api';
import { previewFunnel } from '@/server/services/funnels';

const body = z.object({
  baseFilter: z.object({ conditions: z.array(conditionSchema).max(15).default([]) }).default({ conditions: [] }),
  stages: z.array(z.object({ id: z.string().max(40), name: z.string().max(60), conditions: z.array(conditionSchema).max(15).default([]) })).min(1).max(10),
});
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.funnels.manage', body, rate: { bucket: 'funnel-preview', limit: 120, windowSec: 60 } }, async ({ ctx, body }) => previewFunnel(ctx, body as never));
