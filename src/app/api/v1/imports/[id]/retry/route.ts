import { idParam, route } from '@/server/api';
import { retryImport } from '@/server/services/imports';

export const POST = route({ perm: 'imports.create' }, async ({ ctx, params }) => {
  await retryImport(ctx, idParam(params));
  return { ok: true };
});
