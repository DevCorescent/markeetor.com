import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { rollbackImport } from '@/server/services/imports';

export const POST = route({ perm: 'imports.rollback', stepUp: true, body: z.object({ reason: z.string().trim().min(5).max(300) }) }, async ({ ctx, params, body }) => rollbackImport(ctx, idParam(params), body.reason));
