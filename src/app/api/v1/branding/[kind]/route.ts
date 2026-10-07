import { Readable } from 'node:stream';
import { route } from '@/server/api';
import { defaultFaviconSvg, isBrandAssetKind } from '@/server/branding';
import { AppError } from '@/server/errors';
import { openBrandAsset, removeBrandAsset, uploadBrandAsset } from '@/server/services/branding';
import { getSetting } from '@/server/settings';

// Brand files are public (they appear on the sign-in page, in browser tabs and in link previews).
// They are served with a sandboxing CSP so an SVG can never execute even if opened directly.
const SAFE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'cross-origin-resource-policy': 'cross-origin',
};

export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  if (!isBrandAssetKind(kind)) return new Response('Not found', { status: 404 });
  const versioned = new URL(req.url).searchParams.has('v');
  const file = await openBrandAsset(kind).catch(() => null);
  if (!file) {
    if (kind !== 'favicon') return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    const svg = defaultFaviconSvg((await getSetting('branding')).shortName);
    return new Response(svg, { headers: { ...SAFE_HEADERS, 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=300' } });
  }
  return new Response(Readable.toWeb(file.stream) as ReadableStream, {
    headers: {
      ...SAFE_HEADERS,
      'content-type': file.asset.type,
      'content-length': String(file.asset.size),
      // A versioned URL never changes content, so it can be cached forever.
      'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    },
  });
}

export const POST = route({ perm: 'system.manage', stepUp: true, rate: { bucket: 'brand-upload', limit: 30, windowSec: 3600 } }, async ({ ctx, req, params }) => {
  if (!isBrandAssetKind(params.kind)) throw new AppError('NOT_FOUND', 'Unknown brand asset');
  if (Number(req.headers.get('content-length') ?? 0) > 6 * 1024 * 1024) throw new AppError('PAYLOAD_TOO_LARGE', 'Files are limited to 5 MB');
  if (!(req.headers.get('content-type') ?? '').includes('multipart/form-data')) throw new AppError('UNSUPPORTED_MEDIA', 'Upload the file as multipart/form-data');
  const file = (await req.formData()).get('file');
  if (!(file instanceof File)) throw new AppError('VALIDATION_FAILED', 'Attach an image file');
  const asset = await uploadBrandAsset(ctx, params.kind, Buffer.from(await file.arrayBuffer()));
  return { asset, url: `/api/v1/branding/${params.kind}?v=${asset.v}` };
});

export const DELETE = route({ perm: 'system.manage', stepUp: true }, async ({ ctx, params }) => {
  if (!isBrandAssetKind(params.kind)) throw new AppError('NOT_FOUND', 'Unknown brand asset');
  await removeBrandAsset(ctx, params.kind);
  return { ok: true };
});
