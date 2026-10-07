import { z } from 'zod';
import { selectionSchema } from '@/lib/filters';
import { route } from '@/server/api';
import { revokeLeads } from '@/server/services/distribution';

export const POST = route(
  { perm: 'distribution.reassign', stepUp: true, body: z.object({ selection: selectionSchema, reason: z.string().trim().min(5).max(300) }) },
  async ({ ctx, body }) => revokeLeads(ctx, body.selection, body.reason),
);
