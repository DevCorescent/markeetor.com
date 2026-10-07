import { endpointInputSchema } from '@/lib/email/endpoints';
import { route } from '@/server/api';
import { listEndpoints, saveEndpoint } from '@/server/services/endpoints';

export const GET = route({ perm: 'email.manage' }, async ({ ctx }) => listEndpoints(ctx));
export const POST = route({ perm: 'email.manage', body: endpointInputSchema, rate: { bucket: 'endpoint-save', limit: 120, windowSec: 3600 } }, async ({ ctx, body }) => saveEndpoint(ctx, null, body));
