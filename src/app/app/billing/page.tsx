import { Suspense } from 'react';
import { Billing } from '@/components/marketplace/billing';
import { NotAvailable, Skeleton } from '@/components/ui/states';
import { requirePage } from '@/server/page';
import { orgSettings } from '@/server/services/organizations';

export const metadata = { title: 'Billing' };

export default async function BillingPage() {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: 'crm.billing.view' });
  if (orgSettings(ctx.org?.settings).features.marketplace === false) return <NotAvailable feature="Billing" />;
  return <Suspense fallback={<Skeleton className="h-96" />}><Billing canBuy={ctx.permissions.has('crm.marketplace.request')} /></Suspense>;
}
