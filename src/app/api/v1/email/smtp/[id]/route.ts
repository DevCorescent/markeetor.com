import { idParam, route } from '@/server/api';
import { deleteSmtpAccount, saveSmtpAccount, smtpInput } from '@/server/services/email';

export const PUT = route({ scope: 'ANY', perm: ['email.manage', 'crm.email.manage'], body: smtpInput }, async ({ ctx, params, body }) => saveSmtpAccount(ctx, idParam(params), body));
export const DELETE = route({ scope: 'ANY', perm: ['email.manage', 'crm.email.manage'] }, async ({ ctx, params }) => {
  await deleteSmtpAccount(ctx, idParam(params));
  return { ok: true };
});
