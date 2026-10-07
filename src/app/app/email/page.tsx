import { EmailHub } from '@/components/email/email-hub';
import { NotAvailable } from '@/components/ui/states';
import { orgSettings } from '@/server/services/organizations';
import { requirePage } from '@/server/page';

export const metadata = { title: 'Email' };

export default async function EmailPage() {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'] });
  if (!orgSettings(ctx.org?.settings).features.email) return <NotAvailable feature="Email" />;
  return <EmailHub base="/app" workspace={true} canSend={ctx.permissions.has('crm.email.send')} canManage={ctx.permissions.has('crm.email.manage')} />;
}
