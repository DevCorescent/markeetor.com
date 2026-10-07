import { z } from 'zod';
import { route } from '@/server/api';
import { roiDashboard } from '@/server/services/roi';

export const GET = route(
  { scope: 'ORGANIZATION', perm: ['crm.analytics.read', 'crm.dashboard.view'], query: z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90, 180, 365].includes(d)).default(90) }) },
  async ({ ctx, query }) => roiDashboard(ctx, { days: query.days }),
);
