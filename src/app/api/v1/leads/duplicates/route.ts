import { paginationQuery, route } from '@/server/api';
import { duplicateGroups } from '@/server/services/leads';

export const GET = route({ perm: 'leads.merge', query: paginationQuery }, async ({ query }) => duplicateGroups(query));
