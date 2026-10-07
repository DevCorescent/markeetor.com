import { z } from 'zod';
import { route } from '@/server/api';
import { requestPasswordReset } from '@/server/services/auth';

export const POST = route({ auth: 'public', body: z.object({ email: z.string().email().max(254) }) }, async ({ body, meta }) => {
  await requestPasswordReset(body.email, meta);
  // Identical response whether or not the account exists.
  return { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };
});
