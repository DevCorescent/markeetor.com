import { z } from 'zod';
import { route } from '@/server/api';
import { marketingAdminOverview } from '@/server/services/marketing';

export const GET = route({ perm: 'email.manage', query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }, async ({ query }) => marketingAdminOverview(query.days));
