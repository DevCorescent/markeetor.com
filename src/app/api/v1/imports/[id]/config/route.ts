import { idParam, route } from '@/server/api';
import { configureImport, configureSchema } from '@/server/services/imports';

export const PUT = route({ perm: 'imports.create', body: configureSchema }, async ({ ctx, params, body }) => configureImport(ctx, idParam(params), body));
