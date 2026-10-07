import { idParam, route } from '@/server/api';
import { approveApplication, approveInput } from '@/server/services/onboarding';

export const POST = route({ perm: 'onboarding.manage', body: approveInput }, async ({ ctx, params, body }) => approveApplication(ctx, idParam(params), body));
