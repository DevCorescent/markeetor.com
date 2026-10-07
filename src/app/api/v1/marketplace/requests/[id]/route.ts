import { idParam, route } from '@/server/api';
import { getLeadRequest } from '@/server/services/marketplace';

export const GET = route({ scope: 'ANY', perm: ['marketplace.manage', 'crm.marketplace.view', 'crm.billing.view'] }, async ({ ctx, params }) => getLeadRequest(ctx, idParam(params)));
