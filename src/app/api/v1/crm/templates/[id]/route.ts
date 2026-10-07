import { idParam, route } from '@/server/api';
import { deleteTemplate, templateInput, upsertTemplate } from '@/server/services/crm';

export const PUT = route({ scope: 'ORGANIZATION', perm: 'crm.comms.templates', body: templateInput }, async ({ ctx, params, body }) => upsertTemplate(ctx, idParam(params), body));
export const DELETE = route({ scope: 'ORGANIZATION', perm: 'crm.comms.templates' }, async ({ ctx, params }) => {
  await deleteTemplate(ctx, idParam(params));
  return { ok: true };
});
