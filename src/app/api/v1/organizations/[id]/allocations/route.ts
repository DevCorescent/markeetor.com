import { idParam, paginationQuery, route } from '@/server/api';
import { assignmentHistory } from '@/server/services/distribution';

export const GET = route({ perm: ['orgs.read', 'distribution.read'], query: paginationQuery }, async ({ params, query }) =>
  assignmentHistory({ organizationId: idParam(params), page: query.page, pageSize: query.pageSize }),
);
