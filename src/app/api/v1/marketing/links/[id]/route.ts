import { idParam, route } from '@/server/api';
import { deleteLink } from '@/server/services/capture';

export const DELETE = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'] }, async ({ ctx, params }) => deleteLink(ctx, idParam(params)));
