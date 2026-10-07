import { idParam, route } from '@/server/api';
import { commInput, logCommunication } from '@/server/services/crm';

export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.comms.log', body: commInput }, async ({ ctx, params, body }) => logCommunication(ctx, idParam(params), body));
