import { z } from 'zod';
import { AppError } from '@/server/errors';
import { route } from '@/server/api';
import { confirmMfaEnrollment } from '@/server/services/auth';

export const POST = route(
  { auth: 'session-any', scope: 'ANY', selfService: true, body: z.object({ code: z.string().min(6).max(8) }) },
  async ({ ctx, body }) => {
    if (ctx.session?.mfaPending) throw new AppError('MFA_REQUIRED', 'Complete sign-in first');
    return confirmMfaEnrollment(ctx, body.code);
  },
);
