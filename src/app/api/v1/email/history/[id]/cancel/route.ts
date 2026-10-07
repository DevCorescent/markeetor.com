import { idParam, route } from '@/server/api';
import { cancelMessage } from '@/server/services/endpoints';

export const POST = route({ perm: 'email.manage' }, async ({ ctx, params }) => cancelMessage(ctx, idParam(params)));
