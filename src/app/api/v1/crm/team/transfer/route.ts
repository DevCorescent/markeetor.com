import { z } from 'zod';
import { route } from '@/server/api';
import { transferOwnership } from '@/server/services/crm';

export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.team.manage', body: z.object({ fromUserId: z.string().max(64), toUserId: z.string().max(64) }) }, async ({ ctx, body }) => transferOwnership(ctx, body.fromUserId, body.toUserId));
