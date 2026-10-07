import { z } from 'zod';
import { route } from '@/server/api';
import { mergeClientLeads } from '@/server/services/crm';

export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.leads.merge', body: z.object({ primaryId: z.string().max(64), duplicateId: z.string().max(64) }) }, async ({ ctx, body }) => mergeClientLeads(ctx, body.primaryId, body.duplicateId));
