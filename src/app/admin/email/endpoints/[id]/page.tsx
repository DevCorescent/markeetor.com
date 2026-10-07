import { EndpointPage } from '@/components/email/endpoint-page';
import { requirePage } from '@/server/page';

export const metadata = { title: 'Email endpoint' };

export default async function Page(props: PageProps<'/admin/email/endpoints/[id]'>) {
  await requirePage({ scope: 'PLATFORM', perm: 'email.manage' });
  const { id } = await props.params;
  return <EndpointPage base="/admin" id={id} />;
}
