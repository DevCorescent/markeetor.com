import { idParam, route } from '@/server/api';
import { clientLeadResearch, researchClientLead } from '@/server/services/client-research';

const VIEW = ['crm.leads.read_all', 'crm.leads.read_own'] as const;
export const GET = route({ scope: 'ORGANIZATION', perm: [...VIEW] }, async ({ ctx, params }) => clientLeadResearch(ctx, idParam(params)));
/** Research this lead's company. Stored once on the platform; uses one daily credit unless already researched. */
export const POST = route({ scope: 'ORGANIZATION', perm: [...VIEW], rate: { bucket: 'client-research', limit: 20, windowSec: 60 } }, async ({ ctx, params }) => researchClientLead(ctx, idParam(params)));
