import { idParam, route } from '@/server/api';
import { deleteFunnel, funnelInput, getFunnel, saveFunnel } from '@/server/services/funnels';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.funnels.manage', 'crm.leads.read_all'] }, async ({ ctx, params }) => getFunnel(ctx, idParam(params)));
export const PUT = route({ scope: 'ORGANIZATION', perm: 'crm.funnels.manage', body: funnelInput }, async ({ ctx, params, body }) => saveFunnel(ctx, idParam(params), body));
export const DELETE = route({ scope: 'ORGANIZATION', perm: 'crm.funnels.manage' }, async ({ ctx, params }) => { await deleteFunnel(ctx, idParam(params)); return { ok: true }; });
