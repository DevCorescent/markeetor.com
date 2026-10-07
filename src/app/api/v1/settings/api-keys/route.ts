import { z } from 'zod';
import { route } from '@/server/api';
import { createApiKey, listApiKeys } from '@/server/services/governance';

export const GET = route({ perm: 'system.manage' }, async () => ({ keys: await listApiKeys() }));
export const POST = route(
  { perm: 'system.manage', stepUp: true, body: z.object({ name: z.string().trim().min(2).max(80), scopes: z.array(z.string().max(60)).min(1).max(10), expiresInDays: z.number().int().min(1).max(365).nullable() }) },
  async ({ ctx, body }) => createApiKey(ctx, body),
);
