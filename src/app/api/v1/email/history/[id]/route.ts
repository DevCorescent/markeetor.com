import { idParam, route } from '@/server/api';
import { getMessageDetail } from '@/server/services/endpoints';

export const GET = route({ perm: ['email.send', 'email.manage'] }, async ({ ctx, params }) => getMessageDetail(ctx, idParam(params)));
