import { pricingSchema } from '@/lib/pricing';
import { route } from '@/server/api';
import { getPricing, savePricing } from '@/server/services/marketplace';

export const GET = route({ perm: 'marketplace.manage' }, async () => ({ pricing: await getPricing() }));
export const PUT = route({ perm: 'marketplace.manage', stepUp: true, body: pricingSchema }, async ({ ctx, body }) => ({ pricing: await savePricing(ctx, body) }));
