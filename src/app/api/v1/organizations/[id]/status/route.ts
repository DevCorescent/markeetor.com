import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { setOrgStatus } from '@/server/services/organizations';

export const POST = route(
  { perm: 'orgs.status', body: z.object({ status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'ARCHIVED']), reason: z.string().trim().min(3).max(500) }) },
  async ({ ctx, params, body }) => setOrgStatus(ctx, idParam(params), body.status, body.reason),
);
