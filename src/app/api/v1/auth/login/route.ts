import { z } from 'zod';
import { route } from '@/server/api';
import { sessionCookieHeader } from '@/server/auth/session';
import { login } from '@/server/services/auth';

export const POST = route(
  { auth: 'public', body: z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) }) },
  async ({ body, meta }) => {
    const res = await login(body, meta);
    return new Response(JSON.stringify({ mfaRequired: res.mfaRequired, redirect: res.mfaRequired ? '/login/mfa' : res.scope === 'PLATFORM' ? '/admin' : '/app' }), {
      headers: { 'content-type': 'application/json', 'set-cookie': sessionCookieHeader(res.token, res.maxAgeSec), 'cache-control': 'no-store' },
    });
  },
);
