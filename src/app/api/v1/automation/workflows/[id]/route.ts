import { idParam, route } from '@/server/api';
import { deleteWorkflow, getWorkflow, upsertWorkflow, workflowInput } from '@/server/services/automation';

export const GET = route({ perm: 'automation.manage' }, async ({ params }) => getWorkflow(idParam(params)));
export const PUT = route({ perm: 'automation.manage', body: workflowInput }, async ({ ctx, params, body }) => upsertWorkflow(ctx, idParam(params), body));
export const DELETE = route({ perm: 'automation.manage' }, async ({ ctx, params }) => {
  await deleteWorkflow(ctx, idParam(params));
  return { ok: true };
});
