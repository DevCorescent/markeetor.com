import { z } from 'zod';
import { route } from '@/server/api';
import { listWebhookDeliveries } from '@/server/services/workspace-automation';

export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.settings.manage', query: z.object({ page: z.coerce.number().int().min(1).default(1) }) }, async ({ ctx, query }) => listWebhookDeliveries(ctx, query.page));
