import { route } from '@/server/api';
import { inviteInput, inviteUser } from '@/server/services/users';

export const POST = route({ perm: 'users.invite', body: inviteInput, rate: { bucket: 'invite', limit: 60, windowSec: 3600 } }, async ({ ctx, body }) => inviteUser(ctx, body));
