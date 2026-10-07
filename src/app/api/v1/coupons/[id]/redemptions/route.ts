import { idParam, route } from '@/server/api';
import { couponRedemptions } from '@/server/services/coupons';

export const GET = route({ perm: 'marketplace.manage' }, async ({ params }) => ({ redemptions: await couponRedemptions(idParam(params)) }));
