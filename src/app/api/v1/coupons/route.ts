import { route } from '@/server/api';
import { couponInput, listCoupons, saveCoupon } from '@/server/services/coupons';

export const GET = route({ perm: 'marketplace.manage' }, async () => ({ coupons: await listCoupons() }));
export const POST = route({ perm: 'marketplace.manage', body: couponInput }, async ({ ctx, body }) => saveCoupon(ctx, null, body));
