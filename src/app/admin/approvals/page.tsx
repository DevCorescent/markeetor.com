import { PageHeader } from '@/components/ui/page';
import { requirePage } from '@/server/page';
import { ApprovalsList } from './approvals-list';

export const metadata = { title: 'Approvals' };

export default async function ApprovalsPage() {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'approvals.decide' });
  return (
    <>
      <PageHeader title="Approvals" description="Highly privileged operations require a second administrator. You cannot approve your own requests." />
      <ApprovalsList selfId={ctx.user.id} />
    </>
  );
}
