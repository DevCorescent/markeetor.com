import { idParam, route } from '@/server/api';
import { deleteSavedSearch, savedSearchInput, updateSavedSearch } from '@/server/services/saved-searches';

export const PUT = route({ scope: 'ORGANIZATION', perm: 'crm.marketplace.view', body: savedSearchInput }, async ({ ctx, params, body }) => updateSavedSearch(ctx, idParam(params), body));
export const DELETE = route({ scope: 'ORGANIZATION', perm: 'crm.marketplace.view' }, async ({ ctx, params }) => deleteSavedSearch(ctx, idParam(params)));
