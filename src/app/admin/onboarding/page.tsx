import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/states';
import { requirePage } from '@/server/page';
import { OnboardingHub } from './onboarding-hub';

export const metadata = { title: 'Onboarding' };

export default async function OnboardingPage() {
  await requirePage({ scope: 'PLATFORM', perm: 'onboarding.manage' });
  return <Suspense fallback={<Skeleton className="h-96" />}><OnboardingHub /></Suspense>;
}
