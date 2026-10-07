import { idParam, route } from '@/server/api';
import { deleteSegment, saveSegment, segmentInput } from '@/server/services/marketing';

export const PUT = route({ scope: 'ORGANIZATION', perm: 'crm.email.manage', body: segmentInput }, async ({ ctx, params, body }) => saveSegment(ctx, idParam(params), body));
export const DELETE = route({ scope: 'ORGANIZATION', perm: 'crm.email.manage' }, async ({ ctx, params }) => deleteSegment(ctx, idParam(params)));
