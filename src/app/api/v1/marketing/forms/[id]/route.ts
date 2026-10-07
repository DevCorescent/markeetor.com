import { idParam, route } from '@/server/api';
import { deleteForm, formInput, saveForm } from '@/server/services/capture';

export const PUT = route({ scope: 'ORGANIZATION', perm: 'crm.email.manage', body: formInput }, async ({ ctx, params, body }) => saveForm(ctx, idParam(params), body));
export const DELETE = route({ scope: 'ORGANIZATION', perm: 'crm.email.manage' }, async ({ ctx, params }) => deleteForm(ctx, idParam(params)));
