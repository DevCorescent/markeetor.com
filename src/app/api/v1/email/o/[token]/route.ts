import { requestMeta } from '@/server/api';
import { trackOpen } from '@/server/services/email';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Public open-tracking pixel. Opens are approximate: image proxies and blockers distort them. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const meta = requestMeta(req);
  await trackOpen(token, { ip: meta.ip, userAgent: meta.userAgent }).catch(() => null);
  return new Response(GIF, { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, private', 'content-length': String(GIF.length) } });
}
