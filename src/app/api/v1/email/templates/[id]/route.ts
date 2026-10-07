import { idParam, route } from '@/server/api';
import { archiveEmailTemplate, getEmailTemplate, saveEmailTemplate, templateInput } from '@/server/services/email';

export const GET = route({ scope: 'ANY', perm: ['email.send', 'email.manage', 'crm.email.send', 'crm.email.manage'] }, async ({ ctx, params }) => getEmailTemplate(ctx, idParam(params)));
export const PUT = route({ scope: 'ANY', perm: ['email.manage', 'crm.email.manage'], body: templateInput }, async ({ ctx, params, body }) => saveEmailTemplate(ctx, idParam(params), body));
export const DELETE = route({ scope: 'ANY', perm: ['email.manage', 'crm.email.manage'] }, async ({ ctx, params }) => {
  await archiveEmailTemplate(ctx, idParam(params));
  return { ok: true };
});
