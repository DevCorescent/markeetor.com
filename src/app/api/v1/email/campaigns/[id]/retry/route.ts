import { idParam, route } from '@/server/api';
import { retryFailed } from '@/server/services/email';

export const POST = route({ scope: 'ANY', perm: ['email.send', 'crm.email.send'] }, async ({ ctx, params }) => retryFailed(ctx, idParam(params)));
