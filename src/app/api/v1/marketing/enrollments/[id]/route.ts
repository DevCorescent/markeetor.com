import { idParam, route } from '@/server/api';
import { unenroll } from '@/server/services/sequences';

export const DELETE = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'] }, async ({ ctx, params }) => unenroll(ctx, idParam(params)));
