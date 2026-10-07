import { idParam, route } from '@/server/api';
import { deleteRole, roleInput, updateRole } from '@/server/services/roles';

export const PUT = route({ scope: 'ORGANIZATION', perm: 'crm.roles.manage', body: roleInput }, async ({ ctx, params, body }) => updateRole(ctx, idParam(params), body));
export const DELETE = route({ scope: 'ORGANIZATION', perm: 'crm.roles.manage' }, async ({ ctx, params }) => {
  await deleteRole(ctx, idParam(params));
  return { ok: true };
});
