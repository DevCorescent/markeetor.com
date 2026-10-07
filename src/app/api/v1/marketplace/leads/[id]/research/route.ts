import { idParam, route } from '@/server/api';
import { researchMarketplaceLead } from '@/server/services/client-research';

/** Research an unresearched marketplace company. Stored once for everyone; uses one daily credit. */
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.marketplace.view', rate: { bucket: 'client-research', limit: 20, windowSec: 60 } }, async ({ ctx, params }) => researchMarketplaceLead(ctx, idParam(params)));
