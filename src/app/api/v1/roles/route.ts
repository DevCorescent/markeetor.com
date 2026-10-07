import { z } from 'zod';
import { route } from '@/server/api';
import { createRole, listRoles, roleInput } from '@/server/services/roles';
import { ALL_PERMISSIONS } from '@/lib/permissions';

export const GET = route(
  { perm: ['roles.read', 'users.invite', 'orgs.read'], query: z.object({ scope: z.enum(['PLATFORM', 'ORGANIZATION']).optional(), organizationId: z.string().max(64).optional() }) },
  async ({ ctx, query }) => ({ roles: await listRoles(ctx, query), permissions: ALL_PERMISSIONS }),
);
export const POST = route({ perm: 'roles.manage', stepUp: true, body: roleInput }, async ({ ctx, body }) => createRole(ctx, body));
