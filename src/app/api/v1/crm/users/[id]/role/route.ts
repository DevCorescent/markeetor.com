import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { changeUserRole } from '@/server/services/users';

export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.users.manage', body: z.object({ roleId: z.string().max(64), reason: z.string().trim().min(3).max(300) }) },
  async ({ ctx, params, body }) => changeUserRole(ctx, idParam(params), body.roleId, body.reason),
);
