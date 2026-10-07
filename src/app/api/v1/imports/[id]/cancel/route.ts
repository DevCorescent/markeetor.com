import { idParam, route } from '@/server/api';
import { cancelImport } from '@/server/services/imports';

export const POST = route({ perm: 'imports.create' }, async ({ ctx, params }) => {
  await cancelImport(ctx, idParam(params));
  return { ok: true };
});
