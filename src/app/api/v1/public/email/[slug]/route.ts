import { NextResponse } from 'next/server';
import { requestMeta } from '@/server/api';
import { logger } from '@/server/logger';
import { receiveWebhook } from '@/server/services/endpoints';

/**
 * Inbound email endpoint: `POST /api/v1/public/email/:slug` with `Authorization: Bearer <token>` and a JSON body.
 * Optional: `Idempotency-Key` header, `X-Markeetor-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "t.body")>`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const meta = requestMeta(req);
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return NextResponse.json({ error: 'Send JSON with Content-Type: application/json' }, { status: 415 });
  try {
    const raw = await req.text();
    const res = await receiveWebhook(slug, raw, req.headers, meta.ip);
    return NextResponse.json(res.body, { status: res.status, headers: { 'x-request-id': meta.requestId } });
  } catch (err) {
    logger.error({ err, slug, requestId: meta.requestId }, 'email endpoint webhook failed');
    return NextResponse.json({ error: 'Internal error', requestId: meta.requestId }, { status: 500 });
  }
}
