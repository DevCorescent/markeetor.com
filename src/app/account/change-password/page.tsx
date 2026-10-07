import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui/page';
import { currentContext, homeFor } from '@/server/page';
import { ChangePasswordForm } from './change-password-form';

export const metadata = { title: 'Choose a new password' };

export default async function ChangePasswordPage() {
  const ctx = await currentContext();
  if (!ctx) redirect('/login');
  if (ctx.restriction !== 'PASSWORD_CHANGE_REQUIRED') redirect('/account');
  return (
    <>
      <PageHeader title="Choose a new password" description="You signed in with a temporary password. Pick your own password to continue." />
      <ChangePasswordForm home={homeFor(ctx)} />
    </>
  );
}
