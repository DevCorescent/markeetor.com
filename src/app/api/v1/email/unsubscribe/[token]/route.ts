import { errorResponse, requestMeta, toAppError } from '@/server/api';
import { rateLimit } from '@/server/ratelimit';
import { unsubscribe } from '@/server/services/email';

/** Public one-click unsubscribe (RFC 8058 List-Unsubscribe-Post and the confirmation page). */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const meta = requestMeta(req);
  try {
    const lim = await rateLimit(`unsub:${meta.ip}`, 60, 3600);
    if (!lim.ok) return new Response('Too many requests', { status: 429 });
    const { token } = await ctx.params;
    await unsubscribe(token);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(toAppError(e), meta.requestId);
  }
}

/** A person opening the List-Unsubscribe link in a mail client gets the confirmation page. */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const base = process.env.APP_URL ?? 'http://localhost:3000';
  return Response.redirect(`${base}/unsubscribe/${encodeURIComponent(token)}`, 302);
}
