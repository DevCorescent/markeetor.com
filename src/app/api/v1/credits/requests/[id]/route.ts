import { idParam, route } from '@/server/api';
import { getCreditRequest } from '@/server/services/credits';

export const GET = route({ scope: 'ANY', perm: ['marketplace.manage', 'crm.billing.view'] }, async ({ ctx, params }) => getCreditRequest(ctx, idParam(params)));
