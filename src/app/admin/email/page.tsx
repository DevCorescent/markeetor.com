import { EmailHub } from '@/components/email/email-hub';

import { requirePage } from '@/server/page';

export const metadata = { title: 'Email' };

export default async function EmailPage() {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: ['email.send', 'email.manage'] });

  return <EmailHub base="/admin" workspace={false} canSend={ctx.permissions.has('email.send')} canManage={ctx.permissions.has('email.manage')} canWelcome={ctx.permissions.has('email.manage') && ctx.permissions.has('orgs.create')} />;
}
