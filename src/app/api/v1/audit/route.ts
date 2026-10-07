import { paginationQuery, route } from '@/server/api';
import { auditQuery, searchAudit } from '@/server/services/governance';

export const GET = route({ perm: 'audit.read', query: paginationQuery.merge(auditQuery) }, async ({ query }) => {
  const { page, pageSize, ...q } = query;
  return searchAudit(q, page, pageSize);
});
