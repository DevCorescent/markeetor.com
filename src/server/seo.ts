import { getSetting } from './settings';

type Seo = Awaited<ReturnType<typeof getSetting<'seo'>>>;

/** Canonical public origin: the configured site URL, else APP_URL. */
export function siteUrl(seo: Pick<Seo, 'siteUrl'>) {
  return (seo.siteUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/** Areas behind sign-in. Never indexed, regardless of the indexing switch. */
export const PRIVATE_PATHS = ['/admin', '/app', '/account', '/api/', '/unsubscribe', '/invite', '/reset-password'];
