import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { overrideInput, removePermissionOverride, setPermissionOverride } from '@/server/services/users';

export const PUT = route({ perm: 'roles.manage', stepUp: true, body: overrideInput }, async ({ ctx, params, body }) => setPermissionOverride(ctx, idParam(params), body));
export const DELETE = route({ perm: 'roles.manage', body: z.object({ permissionKey: z.string().max(80) }) }, async ({ ctx, params, body }) => removePermissionOverride(ctx, idParam(params), body.permissionKey));
