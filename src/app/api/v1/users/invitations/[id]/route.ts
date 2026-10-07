import { idParam, route } from '@/server/api';
import { revokeInvitation } from '@/server/services/users';

export const DELETE = route({ perm: 'users.invite' }, async ({ ctx, params }) => {
  await revokeInvitation(ctx, idParam(params));
  return { ok: true };
});
