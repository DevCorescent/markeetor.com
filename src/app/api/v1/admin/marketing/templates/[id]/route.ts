import { idParam, route } from '@/server/api';
import { deleteLibraryTemplate, libraryTemplateInput, saveLibraryTemplate } from '@/server/services/sequences';

export const PUT = route({ perm: 'email.manage', body: libraryTemplateInput }, async ({ ctx, params, body }) => saveLibraryTemplate(ctx, idParam(params), body));
export const DELETE = route({ perm: 'email.manage' }, async ({ ctx, params }) => deleteLibraryTemplate(ctx, idParam(params)));
