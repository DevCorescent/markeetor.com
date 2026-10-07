import { AppError } from '@/server/errors';
import { route } from '@/server/api';
import { startMfaEnrollment } from '@/server/services/auth';

export const POST = route({ auth: 'session-any', scope: 'ANY', selfService: true }, async ({ ctx }) => {
  if (ctx.session?.mfaPending) throw new AppError('MFA_REQUIRED', 'Complete sign-in first');
  return startMfaEnrollment(ctx);
});
