import { idParam, route } from '@/server/api';
import { testEndpoint, testInput } from '@/server/services/endpoints';

export const POST = route({ perm: 'email.manage', body: testInput }, async ({ ctx, params, body }) => testEndpoint(ctx, idParam(params), body));
