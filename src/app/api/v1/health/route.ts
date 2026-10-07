import { z } from 'zod';
import { route } from '@/server/api';
import { clientHealth } from '@/server/services/health';

export const GET = route({ perm: 'orgs.read', query: z.object({ organizationId: z.string().max(64).optional() }) }, async ({ query }) => ({ rows: await clientHealth({ organizationId: query.organizationId }) }));
