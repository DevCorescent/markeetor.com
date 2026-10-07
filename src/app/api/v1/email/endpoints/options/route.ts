import { route } from '@/server/api';
import { endpointOptions } from '@/server/services/endpoints';

export const GET = route({ perm: 'email.manage' }, async ({ ctx }) => endpointOptions(ctx));
