import { z } from 'zod';
import { selectionSchema } from '@/lib/filters';
import { route } from '@/server/api';
import { reassignLeads } from '@/server/services/distribution';

export const POST = route(
  {
    perm: 'distribution.reassign',
    stepUp: true,
    body: z.object({ selection: selectionSchema, toOrganizationId: z.string().max(64), reason: z.string().trim().min(5).max(300), idempotencyKey: z.string().min(8).max(100), respectQuotas: z.boolean().default(true) }),
  },
  async ({ ctx, body }) => reassignLeads(ctx, body.selection, body.toOrganizationId, body.reason, body.idempotencyKey, body.respectQuotas),
);
