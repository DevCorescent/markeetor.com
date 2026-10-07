import { idParam, route } from '@/server/api';
import { deleteNote } from '@/server/services/crm';

export const DELETE = route({ scope: 'ORGANIZATION', perm: 'crm.notes.write' }, async ({ ctx, params }) => {
  await deleteNote(ctx, idParam(params));
  return { ok: true };
});
