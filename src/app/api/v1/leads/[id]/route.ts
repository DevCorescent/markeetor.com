import { idParam, route } from '@/server/api';
import { getLeadDetail, leadEditInput, updateLead } from '@/server/services/leads';

export const GET = route({ perm: 'leads.read', rate: { bucket: 'lead-view', limit: 600, windowSec: 3600 } }, async ({ ctx, params }) => getLeadDetail(ctx, idParam(params)));
export const PATCH = route({ perm: 'leads.update', body: leadEditInput }, async ({ ctx, params, body }) => updateLead(ctx, idParam(params), body));
