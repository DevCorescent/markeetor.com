import Link from 'next/link';
import { getInvitation } from '@/server/services/auth';
import { AuthCard } from '../../auth-card';
import { AcceptForm } from './accept-form';

export const metadata = { title: 'Accept invitation' };

export default async function InvitePage(props: PageProps<'/invite/[token]'>) {
  const { token } = await props.params;
  const inv = await getInvitation(token);
  if (!inv) {
    return (
      <AuthCard title="Invitation unavailable" description="This invitation has expired, was revoked, or has already been used.">
        <Link href="/login" className="text-xs text-subtle hover:text-fg">Go to sign in</Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={`Join ${inv.organizationName}`} description={`You were invited as ${inv.email}. Set a password to activate your account.`}>
      <AcceptForm token={token} name={inv.name} />
    </AuthCard>
  );
}
