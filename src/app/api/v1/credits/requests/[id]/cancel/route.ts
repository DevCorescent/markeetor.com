import { idParam, route } from '@/server/api';
import { cancelCreditRequest } from '@/server/services/credits';

export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.marketplace.request' }, async ({ ctx, params }) => cancelCreditRequest(ctx, idParam(params)));
