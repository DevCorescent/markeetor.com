import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { listInvitations, listUsers } from '@/server/services/users';

export const GET = route(
  {
    perm: 'users.read',
    query: paginationQuery.extend({
      q: z.string().trim().max(100).optional(),
      organizationId: z.string().max(64).optional(),
      platformOnly: z.enum(['1', '0']).optional(),
      status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
    }),
  },
  async ({ ctx, query }) => {
    const res = await listUsers(ctx, { ...query, platformOnly: query.platformOnly === '1' });
    const invitations = query.page === 1 ? await listInvitations(ctx, query.platformOnly === '1' ? null : query.organizationId) : [];
    return { ...res, invitations };
  },
);
