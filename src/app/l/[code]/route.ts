import { NextResponse } from 'next/server';
import { resolveLink } from '@/server/services/capture';

/** Tracked short link: records the click, then redirects (302) to the destination with its UTM tags. */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const url = new URL(req.url);
  const dest = await resolveLink(code, { token: url.searchParams.get('t'), referer: req.headers.get('referer'), userAgent: req.headers.get('user-agent') });
  if (!dest) return new NextResponse('Link not found', { status: 404 });
  return NextResponse.redirect(dest, { status: 302, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}
