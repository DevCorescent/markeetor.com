import { route } from '@/server/api';
import { auditDetached } from '@/server/audit';
import { clearSessionCookieHeader, revokeSession } from '@/server/auth/session';

export const POST = route({ auth: 'session-any', scope: 'ANY', selfService: true }, async ({ ctx }) => {
  if (ctx.session) {
    await revokeSession(ctx.session.id, 'logout');
    await auditDetached(ctx, { action: 'auth.logout', targetType: 'session', targetId: ctx.session.id });
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'set-cookie': clearSessionCookieHeader() } });
});
