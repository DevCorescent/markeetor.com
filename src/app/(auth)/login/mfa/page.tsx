import { redirect } from 'next/navigation';
import { currentContext, homeFor } from '@/server/page';
import { AuthCard } from '../../auth-card';
import { MfaForm } from './mfa-form';

export const metadata = { title: 'Two-factor verification' };

export default async function MfaPage() {
  const ctx = await currentContext();
  if (!ctx) redirect('/login');
  if (!ctx.session?.mfaPending) redirect(homeFor(ctx));
  return (
    <AuthCard title="Two-factor verification" description="Enter the 6-digit code from your authenticator app, or one of your recovery codes.">
      <MfaForm />
    </AuthCard>
  );
}
