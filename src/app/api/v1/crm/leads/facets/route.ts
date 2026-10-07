import { route } from '@/server/api';
import { clientFacets } from '@/server/services/crm';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.leads.read_all', 'crm.leads.read_own', 'crm.tasks.manage'] }, async ({ ctx }) => clientFacets(ctx));
