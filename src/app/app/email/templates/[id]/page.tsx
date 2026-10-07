import { TemplatePage } from '@/components/email/template-page';
import { requirePage } from '@/server/page';

export const metadata = { title: 'Email template' };

export default async function Page(props: PageProps<'/app/email/templates/[id]'>) {
  await requirePage({ scope: 'ORGANIZATION', perm: 'crm.email.manage' });
  const { id } = await props.params;
  return <TemplatePage base="/app" id={id} />;
}
