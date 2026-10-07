import { sequenceInput } from '@/lib/marketing';
import { idParam, route } from '@/server/api';
import { deleteSequence, getSequence, saveSequence } from '@/server/services/sequences';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'] }, async ({ ctx, params }) => getSequence(ctx, idParam(params)));
export const PUT = route({ scope: 'ORGANIZATION', perm: 'crm.email.manage', body: sequenceInput }, async ({ ctx, params, body }) => saveSequence(ctx, idParam(params), body));
export const DELETE = route({ scope: 'ORGANIZATION', perm: 'crm.email.manage' }, async ({ ctx, params }) => deleteSequence(ctx, idParam(params)));
