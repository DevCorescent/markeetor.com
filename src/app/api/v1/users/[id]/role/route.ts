import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { changeUserRole } from '@/server/services/users';

export const POST = route(
  { perm: 'roles.manage', stepUp: true, body: z.object({ roleId: z.string().max(64), reason: z.string().trim().min(3).max(500) }) },
  async ({ ctx, params, body }) => changeUserRole(ctx, idParam(params), body.roleId, body.reason),
);
