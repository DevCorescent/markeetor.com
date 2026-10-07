import { z } from 'zod';
import { route } from '@/server/api';
import { resetPassword } from '@/server/services/auth';

export const POST = route(
  { auth: 'public', body: z.object({ token: z.string().min(20).max(200), password: z.string().min(1).max(256) }), rate: { bucket: 'pwreset-submit', limit: 10, windowSec: 900, by: 'ip' } },
  async ({ body, meta }) => {
    await resetPassword(body.token, body.password, meta);
    return { ok: true };
  },
);
