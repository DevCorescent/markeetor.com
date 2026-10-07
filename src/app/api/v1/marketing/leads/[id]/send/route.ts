import { idParam, route } from '@/server/api';
import { sendFromLead, sendInput } from '@/server/services/marketing';

export const POST = route({ scope: 'ORGANIZATION', perm: ['crm.comms.log', 'crm.email.send'], body: sendInput, rate: { bucket: 'lead-send', limit: 120, windowSec: 3600 } }, async ({ ctx, params, body }) => sendFromLead(ctx, idParam(params), body));
