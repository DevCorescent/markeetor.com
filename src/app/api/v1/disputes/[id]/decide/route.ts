import { idParam, route } from '@/server/api';
import { decideDispute, decideInput } from '@/server/services/disputes';

export const POST = route({ perm: 'marketplace.manage', body: decideInput }, async ({ ctx, params, body }) => decideDispute(ctx, idParam(params), body));
