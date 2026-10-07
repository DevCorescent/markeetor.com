import { redirect } from 'next/navigation';
import { Card, CardBody, CardHeader, DefinitionList } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page';
import { prisma } from '@/server/db';
import { currentContext } from '@/server/page';
import { fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { SimpleTable } from '@/components/ui/simple-table';
import { ThemeCards } from '@/components/shell/theme';
import { getSetting } from '@/server/settings';
import { MfaCard, PasswordCard, SessionsCard } from './account-client';

export const metadata = { title: 'Account & security' };

export default async function AccountPage() {
  const ctx = await currentContext();
  if (!ctx) redirect('/login');
  if (ctx.restriction) redirect(ctx.restriction === 'PASSWORD_CHANGE_REQUIRED' ? '/account/change-password' : '/account/mfa-setup');
  const [user, logins, appearance] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } }),
    prisma.loginEvent.findMany({ where: { userId: ctx.user.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
    getSetting('appearance'),
  ]);
  return (
    <>
      <PageHeader title="Account & security" description="Your profile, appearance, password, two-factor authentication and active sessions." />
      <div className="grid gap-4">
        <Card>
          <CardHeader title="Profile" />
          <CardBody>
            <DefinitionList items={[
              ['Name', user.name], ['Email', user.email], ['Role', ctx.role.name],
              ['Workspace', ctx.org ? `${ctx.org.name} (${ctx.org.code})` : 'Platform'],
              ['Password last changed', fmtDateTime(user.passwordChangedAt)], ['Last sign-in', `${fmtDateTime(user.lastLoginAt)}${user.lastLoginIp ? ` from ${user.lastLoginIp}` : ''}`],
            ]} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Appearance" description={appearance.allowUserChoice ? 'Choose how the product looks for you on this device. System follows your operating system.' : 'Your administrator has set a fixed theme for everyone.'} />
          {appearance.allowUserChoice && <CardBody><ThemeCards /></CardBody>}
        </Card>
        <MfaCard enabled={user.mfaEnabled} recoveryLeft={user.mfaRecoveryHashes.length} />
        <PasswordCard />
        <SessionsCard />
        <Card>
          <CardHeader title="Recent sign-in activity" description="If you don’t recognise an entry, change your password and contact your administrator." />
          <SimpleTable
            rows={logins}
            columns={[
              { key: 'createdAt', header: 'When', render: (r) => fmtDateTime(r.createdAt) },
              { key: 'success', header: 'Result', render: (r) => <Badge tone={r.success ? 'ok' : 'danger'}>{r.success ? 'Success' : 'Failed'}</Badge> },
              { key: 'reason', header: 'Detail', render: (r) => <span className="text-subtle">{r.reason?.replace(/_/g, ' ') ?? '—'}</span> },
              { key: 'ip', header: 'IP', render: (r) => <span className="font-mono text-[11.5px]">{r.ip ?? '—'}</span> },
            ]}
          />
        </Card>
      </div>
    </>
  );
}
