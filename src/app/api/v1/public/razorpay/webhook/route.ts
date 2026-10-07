import { NextResponse } from 'next/server';
import { AppError } from '@/server/errors';
import { logger } from '@/server/logger';
import { handleRazorpayWebhook } from '@/server/services/payments';

/** Razorpay → us. Authenticated by the X-Razorpay-Signature HMAC of the raw body. */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 200_000) return NextResponse.json({ error: 'Too large' }, { status: 413 });
  try {
    return NextResponse.json(await handleRazorpayWebhook(raw, req.headers.get('x-razorpay-signature')));
  } catch (err) {
    if (err instanceof AppError) return NextResponse.json({ error: err.message }, { status: err.code === 'UNAUTHENTICATED' ? 401 : 400 });
    logger.error({ err }, 'razorpay webhook failed');
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
