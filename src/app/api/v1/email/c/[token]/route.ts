import { requestMeta } from '@/server/api';
import { recordClick } from '@/server/services/endpoints';

/** Public click tracker. Only signed links redirect, so it can never be used as an open redirect. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const url = new URL(req.url);
  const meta = requestMeta(req);
  const target = await recordClick(token, url.searchParams.get('u') ?? '', url.searchParams.get('s') ?? '', { ip: meta.ip, userAgent: meta.userAgent }).catch(() => null);
  if (!target) return new Response('This link is invalid or has expired.', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}
