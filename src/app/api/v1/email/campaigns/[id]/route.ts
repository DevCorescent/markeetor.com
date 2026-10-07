import { idParam, route } from '@/server/api';
import { getCampaign } from '@/server/services/email';

export const GET = route({ scope: 'ANY', perm: ['email.send', 'email.manage', 'crm.email.send', 'crm.email.manage'] }, async ({ ctx, params }) => getCampaign(ctx, idParam(params)));
