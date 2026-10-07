import { idParam, route } from '@/server/api';
import { clientLeadEdit, getClientLead, updateClientLead } from '@/server/services/crm';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.leads.read_all', 'crm.leads.read_own'], rate: { bucket: 'crm-view', limit: 600, windowSec: 3600 } }, async ({ ctx, params }) => getClientLead(ctx, idParam(params)));
export const PATCH = route({ scope: 'ORGANIZATION', perm: 'crm.leads.update', body: clientLeadEdit }, async ({ ctx, params, body }) => updateClientLead(ctx, idParam(params), body));
