import { idParam, route } from '@/server/api';
import { withPlatform } from '@/server/db';
import { notFound } from '@/server/errors';
import { runSavedSearch } from '@/server/services/saved-searches';

/** Check a saved search now (alerts and auto-buy run exactly as in the background check). */
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.marketplace.view', rate: { bucket: 'search-run', limit: 20, windowSec: 3600, by: 'org' } }, async ({ ctx, params }) => {
  const s = await withPlatform((tx) => tx.savedSearch.findUnique({ where: { id: idParam(params) }, select: { organizationId: true } }));
  if (!s || s.organizationId !== ctx.orgId) throw notFound('Saved search');
  return runSavedSearch(idParam(params));
});
