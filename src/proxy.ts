import { NextResponse, type NextRequest } from 'next/server';

const COOKIE = process.env.NODE_ENV === 'production' ? '__Host-lc_session' : 'lc_session';
const PUBLIC = ['/login', '/forgot-password', '/reset-password', '/invite', '/forbidden', '/unsubscribe', '/robots.txt', '/sitemap.xml', '/join', '/f', '/l'];

/**
 * Lightweight edge gate: sends cookie-less page requests to sign-in and stamps a request id.
 * This is a UX convenience only — every page and API route performs full server-side authorization.
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const headers = new Headers(req.headers);
  headers.set('x-request-id', requestId);

  const isPublic = pathname === '/' || PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!pathname.startsWith('/api/') && !isPublic && !req.cookies.get(COOKIE)) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('x-request-id', requestId);
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|icon.svg|favicon.ico).*)'],
};
