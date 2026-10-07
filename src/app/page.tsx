import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { FinderHome } from '@/components/onboarding/finder-home';
import { HomepageView } from '@/components/onboarding/homepage-view';
import { shellBranding } from '@/server/branding';
import { currentContext, homeFor } from '@/server/page';
import { catalogHeadline } from '@/server/services/lead-finder';
import { siteHomepage } from '@/server/services/onboarding';

export async function generateMetadata(): Promise<Metadata> {
  const home = await siteHomepage();
  if (!home) return {};
  const { seo } = home.homepage;
  const c = home.form.config.content;
  const finder = home.homepage.mode === 'finder';
  const title = seo.title || (finder ? home.homepage.finder.title.replace(/\*/g, '') : c.title);
  return { title: { absolute: title }, description: seo.description || (finder ? home.homepage.finder.subtitle.replace(/\{\w+\}/g, '').replace(/\s+/g, ' ') : c.subtitle) || undefined, alternates: { canonical: '/' } };
}

/** `/` serves the onboarding form chosen as the site homepage; without one it routes to sign-in or the dashboard. */
export default async function Root() {
  const ctx = await currentContext();
  const home = await siteHomepage({ countView: !ctx });
  if (home) {
    const { mark } = await shellBranding();
    const viewer = ctx && !ctx.session?.mfaPending ? { dashboardHref: homeFor(ctx) } : null;
    const brand = { productName: mark.productName, shortName: mark.shortName, logoUrl: mark.logoUrl, logoDarkUrl: mark.logoDarkUrl };
    if (home.homepage.mode === 'finder') return <FinderHome form={home.form} homepage={home.homepage} headline={await catalogHeadline()} viewer={viewer} brand={brand} className="min-h-dvh" />;
    return <HomepageView form={home.form} homepage={home.homepage} viewer={viewer} brand={{ productName: mark.productName, shortName: mark.shortName, logoUrl: mark.logoUrl, logoDarkUrl: mark.logoDarkUrl }} className="min-h-screen" />;
  }
  if (!ctx) redirect('/login');
  if (ctx.session?.mfaPending) redirect('/login/mfa');
  redirect(homeFor(ctx));
}
