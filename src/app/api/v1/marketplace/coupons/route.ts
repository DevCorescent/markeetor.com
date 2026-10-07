import { route } from '@/server/api';
import { availableCoupons } from '@/server/services/coupons';

/** Coupons this workspace can apply right now. */
export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.marketplace.view', 'crm.billing.view'] }, async ({ ctx }) => ({ coupons: await availableCoupons(ctx.orgId!) }));
