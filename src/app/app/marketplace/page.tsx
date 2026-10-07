import { Suspense } from 'react';
import { Marketplace } from '@/components/marketplace/marketplace';
import { NotAvailable, Skeleton } from '@/components/ui/states';
import { requirePage } from '@/server/page';
import { orgSettings } from '@/server/services/organizations';

export const metadata = { title: 'Lead marketplace' };

export default async function MarketplacePage() {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: 'crm.marketplace.view' });
  if (orgSettings(ctx.org?.settings).features.marketplace === false) return <NotAvailable feature="The lead marketplace" />;
  return <Suspense fallback={<Skeleton className="h-96" />}><Marketplace canRequest={ctx.permissions.has('crm.marketplace.request')} /></Suspense>;
}
