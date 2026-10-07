import type { MetadataRoute } from 'next';
import { PRIVATE_PATHS, siteUrl } from '@/server/seo';
import { getSetting } from '@/server/settings';

// Reflects Settings → SEO immediately (no build-time caching).
export const dynamic = 'force-dynamic';

export default async function robots(): Promise<MetadataRoute.Robots> {
  const seo = await getSetting('seo');
  const base = siteUrl(seo);
  if (!seo.allowIndexing) return { rules: { userAgent: '*', disallow: '/' } };
  return {
    rules: { userAgent: '*', allow: '/', disallow: PRIVATE_PATHS },
    sitemap: seo.sitemapEnabled ? `${base}/sitemap.xml` : undefined,
    host: base,
  };
}
