import { pricingSchema } from '@/lib/pricing';
import { route } from '@/server/api';
import { pricingImpact } from '@/server/services/marketplace';

/** Re-prices a sample of the live catalog under unsaved settings (nothing is saved). */
export const POST = route({ perm: 'marketplace.manage', body: pricingSchema, rate: { bucket: 'pricing-preview', limit: 30, windowSec: 60 } }, async ({ body }) => pricingImpact(body));
