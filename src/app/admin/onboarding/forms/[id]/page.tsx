import { headers } from 'next/headers';
import { shellBranding } from '@/server/branding';
import { requirePage } from '@/server/page';
import { FormBuilder } from './form-builder';

export const metadata = { title: 'Form builder' };

export default async function FormBuilderPage(props: PageProps<'/admin/onboarding/forms/[id]'>) {
  await requirePage({ scope: 'PLATFORM', perm: 'onboarding.manage' });
  const { id } = await props.params;
  const { mark } = await shellBranding();
  const h = await headers();
  const origin = `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('x-forwarded-host') ?? h.get('host')}`;
  return <FormBuilder id={id} origin={origin} brand={{ productName: mark.productName, shortName: mark.shortName, logoUrl: mark.logoUrl, logoDarkUrl: mark.logoDarkUrl }} />;
}
