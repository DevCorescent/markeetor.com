import { idParam, route } from '@/server/api';
import { deleteTask, taskUpdate, updateTask } from '@/server/services/crm';

export const PATCH = route({ scope: 'ORGANIZATION', perm: 'crm.tasks.manage', body: taskUpdate }, async ({ ctx, params, body }) => updateTask(ctx, idParam(params), body));
export const DELETE = route({ scope: 'ORGANIZATION', perm: 'crm.tasks.manage' }, async ({ ctx, params }) => {
  await deleteTask(ctx, idParam(params));
  return { ok: true };
});
