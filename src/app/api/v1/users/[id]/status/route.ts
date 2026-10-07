import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { setUserStatus } from '@/server/services/users';

export const POST = route(
  { perm: 'users.manage', body: z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']), reason: z.string().trim().min(3).max(500) }) },
  async ({ ctx, params, body }) => setUserStatus(ctx, idParam(params), body.status, body.reason),
);
