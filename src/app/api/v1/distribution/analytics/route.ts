import { z } from 'zod';
import { route } from '@/server/api';
import { distributionAnalytics } from '@/server/services/distribution-insights';

export const GET = route(
  { perm: ['distribution.read', 'analytics.read'], query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30), organizationId: z.string().max(64).optional(), industry: z.string().max(120).optional() }) },
  async ({ query }) => distributionAnalytics(query),
);
