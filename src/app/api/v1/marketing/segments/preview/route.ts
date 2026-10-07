import { z } from 'zod';
import { filterSchema } from '@/lib/filters';
import { route } from '@/server/api';
import { segmentPreview } from '@/server/services/marketing';

export const POST = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'], body: z.object({ filter: filterSchema }) }, async ({ ctx, body }) => segmentPreview(ctx, body.filter));
