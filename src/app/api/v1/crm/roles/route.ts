import { route } from '@/server/api';
import { ORG_PERMISSIONS } from '@/lib/permissions';
import { createRole, listRoles, roleInput } from '@/server/services/roles';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.users.manage', 'crm.roles.manage', 'crm.team.read'] }, async ({ ctx }) => ({ roles: await listRoles(ctx), permissions: ORG_PERMISSIONS }));
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.roles.manage', body: roleInput }, async ({ ctx, body }) => createRole(ctx, body));
