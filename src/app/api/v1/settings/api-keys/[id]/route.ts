import { idParam, route } from '@/server/api';
import { revokeApiKey } from '@/server/services/governance';

export const DELETE = route({ perm: 'system.manage' }, async ({ ctx, params }) => {
  await revokeApiKey(ctx, idParam(params));
  return { ok: true };
});
