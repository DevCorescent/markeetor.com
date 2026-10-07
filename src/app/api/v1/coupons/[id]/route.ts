import { idParam, route } from '@/server/api';
import { couponInput, deleteCoupon, saveCoupon } from '@/server/services/coupons';

export const PUT = route({ perm: 'marketplace.manage', body: couponInput }, async ({ ctx, params, body }) => saveCoupon(ctx, idParam(params), body));
export const DELETE = route({ perm: 'marketplace.manage' }, async ({ ctx, params }) => deleteCoupon(ctx, idParam(params)));
