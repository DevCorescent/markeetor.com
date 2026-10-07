import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { cookies } from 'next/headers';
import { getBranding } from '@/server/branding';
import { ResponsiveTables } from '@/components/shell/responsive-tables';
import { siteUrl } from '@/server/seo';
import { getSetting } from '@/server/settings';
import { isThemePref, SYSTEM_THEME_SCRIPT, THEME_COOKIE, type ThemePref } from '@/lib/theme';
import './globals.css';

const sans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const mono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

/** Title, description, indexing, verification and social cards all come from Settings → Branding / SEO. */
export async function generateMetadata(): Promise<Metadata> {
  const [b, seo] = await Promise.all([getBranding(), getSetting('seo')]);
  const title = seo.defaultTitle || b.productName;
  const template = seo.titleTemplate.replaceAll('{product}', b.productName);
  const index = seo.allowIndexing;
  return {
    metadataBase: new URL(siteUrl(seo)),
    applicationName: b.productName,
    title: { default: title, template },
    description: seo.description || undefined,
    keywords: seo.keywords.length ? seo.keywords : undefined,
    robots: { index, follow: index, googleBot: { index, follow: index } },
    verification: {
      google: seo.googleVerification || undefined,
      other: seo.bingVerification ? { 'msvalidate.01': seo.bingVerification } : undefined,
    },
    icons: { icon: b.faviconUrl, apple: b.faviconUrl },
    openGraph: { type: 'website', siteName: b.productName, title, description: seo.description || undefined, images: b.ogImageUrl ? [{ url: b.ogImageUrl }] : undefined },
    twitter: { card: b.ogImageUrl ? 'summary_large_image' : 'summary', title, description: seo.description || undefined, site: seo.twitterHandle ? `@${seo.twitterHandle.replace(/^@/, '')}` : undefined, images: b.ogImageUrl ? [b.ogImageUrl] : undefined },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7f5' },
    { media: '(prefers-color-scheme: dark)', color: '#050505' },
  ],
};

/**
 * Theme resolution: the user's own choice (cookie) wins when the platform allows it, otherwise the
 * platform default. Explicit light/dark is rendered on the server; "system" is resolved by a tiny
 * pre-paint script, so neither path flashes the wrong theme.
 */
async function themePref(): Promise<ThemePref> {
  const appearance = await getSetting('appearance').catch(() => ({ defaultTheme: 'dark' as const, allowUserChoice: true }));
  const cookie = (await cookies()).get(THEME_COOKIE)?.value;
  return appearance.allowUserChoice && isThemePref(cookie) ? cookie : appearance.defaultTheme;
}

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  const pref = await themePref();
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} h-full`}
      data-theme-pref={pref}
      data-theme={pref === 'system' ? undefined : pref}
      suppressHydrationWarning
    >
      <head>
        {pref === 'system' && <script dangerouslySetInnerHTML={{ __html: SYSTEM_THEME_SCRIPT }} />}
      </head>
      <body className="min-h-full">{children}<ResponsiveTables /></body>
    </html>
  );
}
