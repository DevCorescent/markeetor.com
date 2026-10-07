import { redirect } from 'next/navigation';
import { currentContext, homeFor } from '@/server/page';
import { AuthCard } from '../auth-card';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in' };

export default async function LoginPage(props: PageProps<'/login'>) {
  const ctx = await currentContext();
  if (ctx && !ctx.session?.mfaPending) redirect(homeFor(ctx));
  const sp = await props.searchParams;
  const error = typeof sp.error === 'string' ? sp.error.slice(0, 200) : null;
  return (
    <AuthCard title="Sign in" description="Use your work email to access your workspace.">
      <LoginForm initialError={error} />
    </AuthCard>
  );
}
