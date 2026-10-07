import { idParam, route } from '@/server/api';
import { getInvoice } from '@/server/services/finance';

export const GET = route({ scope: 'ANY', perm: ['marketplace.manage', 'crm.billing.view'] }, async ({ ctx, params }) => getInvoice(ctx, idParam(params)));
