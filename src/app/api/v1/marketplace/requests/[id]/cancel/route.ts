import { idParam, route } from '@/server/api';
import { cancelLeadRequest } from '@/server/services/marketplace';

export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.marketplace.request' }, async ({ ctx, params }) => cancelLeadRequest(ctx, idParam(params)));
