import { Readable } from 'node:stream';
import { openFormAsset } from '@/server/services/onboarding';

export async function GET(req: Request, ctx: { params: Promise<{ slug: string; kind: string }> }) {
  const { slug, kind } = await ctx.params;
  if (kind !== 'logo' && kind !== 'cover') return new Response('Not found', { status: 404 });
  const file = await openFormAsset(slug, kind).catch(() => null);
  if (!file) return new Response('Not found', { status: 404 });
  return new Response(Readable.toWeb(file.stream) as ReadableStream, {
    headers: {
      'content-type': file.asset.type, 'content-length': String(file.asset.size), 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'cache-control': new URL(req.url).searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    },
  });
}
