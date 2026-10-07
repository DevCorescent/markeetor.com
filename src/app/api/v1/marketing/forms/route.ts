import { route } from '@/server/api';
import { formInput, listForms, saveForm } from '@/server/services/capture';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'] }, async ({ ctx }) => ({ rows: await listForms(ctx), base: process.env.APP_URL ?? '' }));
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.email.manage', body: formInput }, async ({ ctx, body }) => saveForm(ctx, null, body));
