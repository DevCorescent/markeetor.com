import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { assignmentHistory } from '@/server/services/distribution';

export const GET = route({ perm: 'distribution.read', query: paginationQuery.extend({ organizationId: z.string().max(64).optional(), leadId: z.string().max(64).optional() }) }, async ({ query }) => assignmentHistory(query));
