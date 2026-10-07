import { endpointInputSchema } from '@/lib/email/endpoints';
import { idParam, route } from '@/server/api';
import { deleteEndpoint, getEndpoint, saveEndpoint } from '@/server/services/endpoints';

export const GET = route({ perm: 'email.manage' }, async ({ ctx, params }) => getEndpoint(ctx, idParam(params)));
export const PUT = route({ perm: 'email.manage', body: endpointInputSchema, rate: { bucket: 'endpoint-save', limit: 120, windowSec: 3600 } }, async ({ ctx, params, body }) => saveEndpoint(ctx, idParam(params), body));
export const DELETE = route({ perm: 'email.manage', stepUp: true }, async ({ ctx, params }) => deleteEndpoint(ctx, idParam(params)));
