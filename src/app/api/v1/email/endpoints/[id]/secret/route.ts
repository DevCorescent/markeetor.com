import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { rotateEndpointSecret } from '@/server/services/endpoints';

/** Issues a new webhook token or signing secret. The value is shown once; the old one stops working immediately. */
export const POST = route({ perm: 'email.manage', stepUp: true, body: z.object({ kind: z.enum(['token', 'signing']) }) }, async ({ ctx, params, body }) => rotateEndpointSecret(ctx, idParam(params), body.kind));
