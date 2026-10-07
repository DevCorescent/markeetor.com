import { route } from '@/server/api';
import { catalogFacets } from '@/server/services/marketplace';

export const GET = route({ scope: 'ANY', perm: ['crm.marketplace.view', 'marketplace.manage'] }, async ({ ctx }) => catalogFacets(ctx));
