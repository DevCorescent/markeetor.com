import { route } from '@/server/api';
import { clientAnalytics, rangeSchema } from '@/server/services/analytics';

export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.analytics.read', query: rangeSchema.pick({ from: true, to: true }) }, async ({ ctx, query }) =>
  clientAnalytics(ctx.orgId!, { ...query, orgIds: [], sources: [], campaigns: [] }),
);
