import { Suspense } from 'react';
import { WorkflowBuilder } from '@/components/automation/builder';
import { Skeleton } from '@/components/ui/states';
import { requirePage } from '@/server/page';

export const metadata = { title: 'Workflow builder' };

export default async function WorkflowPage({ params }: PageProps<'/admin/automation/[id]'>) {
  await requirePage({ scope: 'PLATFORM', perm: 'automation.manage' });
  const { id } = await params;
  return (
    <Suspense fallback={<Skeleton className="h-[calc(100dvh-7rem)]" />}>
      <WorkflowBuilder id={id} />
    </Suspense>
  );
}
