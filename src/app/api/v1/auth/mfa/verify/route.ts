import { z } from 'zod';
import { route } from '@/server/api';
import { sessionCookieHeader } from '@/server/auth/session';
import { verifyMfa } from '@/server/services/auth';

export const POST = route(
  { auth: 'session-any', scope: 'ANY', selfService: true, body: z.object({ code: z.string().min(6).max(20) }) },
  async ({ ctx, body }) => {
    const res = await verifyMfa(ctx, body.code);
    return new Response(JSON.stringify({ ok: true, redirect: ctx.scope === 'PLATFORM' ? '/admin' : '/app' }), {
      headers: { 'content-type': 'application/json', 'set-cookie': sessionCookieHeader(res.token, res.maxAgeSec) },
    });
  },
);
