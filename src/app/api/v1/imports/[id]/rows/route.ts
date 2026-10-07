import { z } from 'zod';
import { idParam, paginationQuery, route } from '@/server/api';
import { listImportRows } from '@/server/services/imports';

export const GET = route(
  { perm: 'imports.read', query: paginationQuery.extend({ status: z.enum(['VALID', 'INVALID', 'DUPLICATE', 'INSERTED', 'UPDATED', 'SKIPPED', 'FAILED']).optional() }) },
  async ({ params, query }) => listImportRows(idParam(params), query),
);
