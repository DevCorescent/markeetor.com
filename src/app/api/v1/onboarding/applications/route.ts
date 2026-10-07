import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { listApplications } from '@/server/services/onboarding';

export const GET = route(
  { perm: 'onboarding.manage', query: paginationQuery.extend({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SPAM']).optional(), formId: z.string().max(64).optional(), q: z.string().trim().max(120).optional() }) },
  async ({ query }) => listApplications(query),
);
