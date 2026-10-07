import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { listAlerts } from '@/server/services/governance';

export const GET = route(
  { perm: 'security.read', query: paginationQuery.extend({ status: z.enum(['active', 'OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED']).optional(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional() }) },
  async ({ query }) => listAlerts(query),
);
