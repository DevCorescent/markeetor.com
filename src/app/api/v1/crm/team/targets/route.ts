import { z } from 'zod';
import { route } from '@/server/api';
import { setTarget } from '@/server/services/crm';

export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.team.manage', body: z.object({ userId: z.string().max(64), metric: z.enum(['CONTACTS', 'CONVERSIONS']), target: z.number().int().min(0).max(100_000) }) },
  async ({ ctx, body }) => setTarget(ctx, body.userId, body.metric, body.target),
);
