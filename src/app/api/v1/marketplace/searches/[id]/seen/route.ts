import { idParam, route } from '@/server/api';
import { markSearchSeen } from '@/server/services/saved-searches';

export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.marketplace.view' }, async ({ ctx, params }) => markSearchSeen(ctx, idParam(params)));
