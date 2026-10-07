import { route } from '@/server/api';
import { listTemplates, templateInput, upsertTemplate } from '@/server/services/crm';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.comms.log', 'crm.comms.templates'] }, async ({ ctx }) => ({ templates: await listTemplates(ctx) }));
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.comms.templates', body: templateInput }, async ({ ctx, body }) => upsertTemplate(ctx, null, body));
