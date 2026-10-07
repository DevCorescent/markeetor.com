import type { MetadataRoute } from 'next';
import { notFound } from 'next/navigation';
import { PRIVATE_PATHS, siteUrl } from '@/server/seo';
import { getSetting } from '@/server/settings';
import { siteHomepage } from '@/server/services/onboarding';

export const dynamic = 'force-dynamic';

/** Lists only public pages chosen in Settings → SEO. Private areas are filtered out defensively. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const seo = await getSetting('seo');
  if (!seo.sitemapEnabled) notFound();
  const base = siteUrl(seo);
  const home = await siteHomepage();
  const paths = [...new Set([...(home ? ['/'] : []), ...seo.sitemapPaths])].filter((p) => !PRIVATE_PATHS.some((x) => p === x.replace(/\/$/, '') || p.startsWith(x.endsWith('/') ? x : `${x}/`)));
  const now = new Date();
  return paths.map((p) => ({ url: `${base}${p === '/' ? '' : p}`, lastModified: now, changeFrequency: 'weekly', priority: p === '/' ? 1 : 0.6 }));
}
