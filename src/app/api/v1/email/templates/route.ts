import { route } from '@/server/api';
import { listEmailTemplates, saveEmailTemplate, templateInput } from '@/server/services/email';

export const GET = route({ scope: 'ANY', perm: ['email.send', 'email.manage', 'crm.email.send', 'crm.email.manage'] }, async ({ ctx }) => ({ templates: await listEmailTemplates(ctx) }));
export const POST = route({ scope: 'ANY', perm: ['email.manage', 'crm.email.manage'], body: templateInput }, async ({ ctx, body }) => saveEmailTemplate(ctx, null, body));
