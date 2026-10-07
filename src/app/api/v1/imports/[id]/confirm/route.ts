import { idParam, route } from '@/server/api';
import { confirmImport } from '@/server/services/imports';

export const POST = route({ perm: 'imports.create' }, async ({ ctx, params }) => {
  await confirmImport(ctx, idParam(params));
  return { ok: true };
});
