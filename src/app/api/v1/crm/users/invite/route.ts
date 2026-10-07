import { route } from '@/server/api';
import { inviteInput, inviteUser } from '@/server/services/users';

/** Workspace invitations: always bound to the caller's organization, never above the caller's own role. */
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.users.manage', body: inviteInput.omit({ organizationId: true }), rate: { bucket: 'invite', limit: 30, windowSec: 3600 } }, async ({ ctx, body }) =>
  inviteUser(ctx, { ...body, organizationId: ctx.orgId }),
);
