import { idParam, route } from '@/server/api';
import { formSubmissions } from '@/server/services/capture';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'] }, async ({ ctx, params }) => formSubmissions(ctx, idParam(params)));
