import { idParam, route } from '@/server/api';
import { deleteForm, getForm, saveForm, saveFormInput } from '@/server/services/onboarding';

export const GET = route({ perm: 'onboarding.manage' }, async ({ params }) => getForm(idParam(params)));
export const PUT = route({ perm: 'onboarding.manage', body: saveFormInput }, async ({ ctx, params, body }) => saveForm(ctx, idParam(params), body));
export const DELETE = route({ perm: 'onboarding.manage' }, async ({ ctx, params }) => deleteForm(ctx, idParam(params)));
