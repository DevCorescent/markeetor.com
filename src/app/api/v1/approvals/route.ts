import { z } from 'zod';
import { route } from '@/server/api';
import { listApprovals } from '@/server/services/approvals';

export const GET = route({ perm: 'approvals.decide', query: z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }) }, async ({ query }) => ({ rows: await listApprovals(query.status) }));
