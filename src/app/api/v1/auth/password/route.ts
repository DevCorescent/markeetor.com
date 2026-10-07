import { z } from 'zod';
import { route } from '@/server/api';
import { changePassword } from '@/server/services/auth';

export const POST = route(
  { scope: 'ANY', selfService: true, allowPasswordChangeRestriction: true, body: z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) }), rate: { bucket: 'pwchange', limit: 10, windowSec: 3600 } },
  async ({ ctx, body }) => {
    await changePassword(ctx, body.currentPassword, body.newPassword);
    return { ok: true };
  },
);
