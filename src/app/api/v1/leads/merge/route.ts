import { z } from 'zod';
import { route } from '@/server/api';
import { mergeLeads } from '@/server/services/leads';

export const POST = route(
  { perm: 'leads.merge', body: z.object({ primaryId: z.string().max(64), duplicateIds: z.array(z.string().max(64)).min(1).max(20), reason: z.string().trim().min(3).max(300) }) },
  async ({ ctx, body }) => mergeLeads(ctx, body.primaryId, body.duplicateIds, body.reason),
);
