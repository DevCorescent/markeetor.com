import { idParam, route } from '@/server/api';
import { cancelCampaign } from '@/server/services/email';

export const POST = route({ scope: 'ANY', perm: ['email.send', 'crm.email.send'] }, async ({ ctx, params }) => cancelCampaign(ctx, idParam(params)));
