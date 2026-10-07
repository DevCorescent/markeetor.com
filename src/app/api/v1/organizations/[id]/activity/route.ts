import { idParam, paginationQuery, route } from '@/server/api';
import { searchAudit } from '@/server/services/governance';

export const GET = route({ perm: ['orgs.read'], query: paginationQuery }, async ({ params, query }) =>
  searchAudit({ organizationId: idParam(params) }, query.page, query.pageSize),
);
