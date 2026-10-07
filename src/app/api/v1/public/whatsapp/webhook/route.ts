import { NextResponse } from 'next/server';
import { AppError } from '@/server/errors';
import { logger } from '@/server/logger';
import { handleWhatsAppWebhook } from '@/server/services/marketing';

/** WhatsApp Cloud API verification handshake. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const ok = u.searchParams.get('hub.mode') === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && u.searchParams.get('hub.verify_token') === process.env.WHATSAPP_VERIFY_TOKEN;
  return ok ? new NextResponse(u.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new NextResponse('Forbidden', { status: 403 });
}

/** Delivery receipts and replies (signed with X-Hub-Signature-256 using WHATSAPP_APP_SECRET). */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 500_000) return NextResponse.json({ error: 'Too large' }, { status: 413 });
  try {
    return NextResponse.json(await handleWhatsAppWebhook(raw, req.headers.get('x-hub-signature-256')));
  } catch (err) {
    if (err instanceof AppError) return NextResponse.json({ error: err.message }, { status: 401 });
    logger.error({ err }, 'whatsapp webhook failed');
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
