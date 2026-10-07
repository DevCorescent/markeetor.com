import { route } from '@/server/api';
import { createSavedSearch, listSavedSearches, savedSearchInput } from '@/server/services/saved-searches';

export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.marketplace.view' }, async ({ ctx }) => listSavedSearches(ctx));
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.marketplace.view', body: savedSearchInput }, async ({ ctx, body }) => createSavedSearch(ctx, body));
