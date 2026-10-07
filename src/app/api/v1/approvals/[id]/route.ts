import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { decideApproval } from '@/server/services/approvals';

export const POST = route(
  { perm: 'approvals.decide', stepUp: true, body: z.object({ approve: z.boolean(), note: z.string().trim().min(3).max(500) }) },
  async ({ ctx, params, body }) => decideApproval(ctx, idParam(params), body.approve, body.note),
);
