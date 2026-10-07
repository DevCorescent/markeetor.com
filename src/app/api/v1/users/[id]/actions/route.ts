import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { assertCan } from '@/server/auth/context';
import { adminUserAction } from '@/server/services/users';

export const POST = route(
  { perm: ['users.manage', 'users.sessions.revoke'], body: z.object({ action: z.enum(['unlock', 'reset_mfa', 'send_password_reset', 'revoke_sessions']), reason: z.string().trim().min(3).max(500) }) },
  async ({ ctx, params, body }) => {
    if (body.action === 'revoke_sessions') assertCan(ctx, 'users.sessions.revoke', 'users.manage');
    else assertCan(ctx, 'users.manage');
    return adminUserAction(ctx, idParam(params), body.action, body.reason);
  },
);
