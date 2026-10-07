import { z } from 'zod';
import { route } from '@/server/api';
import { demandInsights } from '@/server/services/insights';

export const GET = route({ perm: 'analytics.read', query: z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90, 180, 365].includes(d)).default(30) }) }, async ({ query }) => demandInsights({ days: query.days }));
