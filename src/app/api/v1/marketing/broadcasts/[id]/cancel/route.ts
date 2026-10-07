import { idParam, route } from '@/server/api';
import { cancelBroadcast } from '@/server/services/marketing';

export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.email.manage' }, async ({ ctx, params }) => cancelBroadcast(ctx, idParam(params)));
