import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PublicFormView } from '@/components/onboarding/public-form';
import { shellBranding } from '@/server/branding';
import { currentContext } from '@/server/page';
import { publicForm } from '@/server/services/onboarding';

async function load(slug: string, preview: boolean) {
  // Staff can preview drafts; everyone else only sees published or closed forms.
  const staff = preview ? (await currentContext())?.permissions.has('onboarding.manage') : false;
  return publicForm(slug, { preview: Boolean(staff), countView: !staff });
}

export async function generateMetadata({ params, searchParams }: PageProps<'/join/[slug]'>): Promise<Metadata> {
  const { slug } = await params;
  const preview = (await searchParams).preview === '1' && Boolean((await currentContext())?.permissions.has('onboarding.manage'));
  const f = await publicForm(slug, { preview });
  return f ? { title: f.config.content.title, description: f.config.content.subtitle || undefined } : { title: 'Not found' };
}

export default async function JoinPage({ params, searchParams }: PageProps<'/join/[slug]'>) {
  const { slug } = await params;
  const form = await load(slug, (await searchParams).preview === '1');
  if (!form) notFound();
  const { mark } = await shellBranding();
  return (
    <PublicFormView form={form} brand={{ productName: mark.productName, shortName: mark.shortName, logoUrl: mark.logoUrl, logoDarkUrl: mark.logoDarkUrl }} />
  );
}
