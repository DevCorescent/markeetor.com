import { requirePage } from '@/server/page';
import { DistributionHub } from './distribution-hub';

export const metadata = { title: 'Distribution' };

export default async function DistributionPage() {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'distribution.read' });
  const p = (k: string) => ctx.permissions.has(k);
  return <DistributionHub perms={{ create: p('distribution.create'), rules: p('distribution.rules') }} />;
}
