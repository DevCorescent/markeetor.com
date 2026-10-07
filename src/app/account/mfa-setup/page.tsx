import { redirect } from 'next/navigation';
import { currentContext } from '@/server/page';
import { PageHeader } from '@/components/ui/page';
import { MfaSetup } from './mfa-setup';

export const metadata = { title: 'Set up two-factor authentication' };

export default async function MfaSetupPage() {
  const ctx = await currentContext();
  if (!ctx) redirect('/login');
  if (ctx.restriction === 'PASSWORD_CHANGE_REQUIRED') redirect('/account/change-password');
  if (ctx.user.mfaEnabled) redirect('/account');
  return (
    <>
      <PageHeader title="Set up two-factor authentication" description={ctx.restriction ? 'Your organization requires two-factor authentication before you can continue.' : 'Protect your account with a second factor.'} />
      <MfaSetup home={ctx.scope === 'PLATFORM' ? '/admin' : '/app'} />
    </>
  );
}
