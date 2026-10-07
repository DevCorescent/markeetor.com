import { idParam, route } from '@/server/api';
import { completeCreditRequest, completeInput } from '@/server/services/credits';

/** Payment received: adds the credits to the workspace. */
export const POST = route({ perm: 'marketplace.manage', stepUp: true, body: completeInput }, async ({ ctx, params, body }) => completeCreditRequest(ctx, idParam(params), body));
