import Link from 'next/link';
import { AuthCard } from '../auth-card';
import { ResetForm } from './reset-form';

export const metadata = { title: 'Set a new password' };

export default async function ResetPage(props: PageProps<'/reset-password'>) {
  const sp = await props.searchParams;
  const token = typeof sp.token === 'string' ? sp.token : '';
  return (
    <AuthCard title="Set a new password" description="All existing sessions will be signed out.">
      {token ? <ResetForm token={token} /> : <p className="text-sm text-muted">This link is incomplete. <Link className="underline" href="/forgot-password">Request a new one.</Link></p>}
    </AuthCard>
  );
}
