import { TemplatePage } from '@/components/email/template-page';
import { requirePage } from '@/server/page';

export const metadata = { title: 'Email template' };

export default async function Page(props: PageProps<'/admin/email/templates/[id]'>) {
  await requirePage({ scope: 'PLATFORM', perm: 'email.manage' });
  const { id } = await props.params;
  return <TemplatePage base="/admin" id={id} />;
}
