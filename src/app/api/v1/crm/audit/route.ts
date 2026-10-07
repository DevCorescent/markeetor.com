import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { workspaceAudit } from '@/server/services/crm';

export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.audit.read', query: paginationQuery.extend({ action: z.string().max(80).optional() }) }, async ({ ctx, query }) => workspaceAudit(ctx, query));
