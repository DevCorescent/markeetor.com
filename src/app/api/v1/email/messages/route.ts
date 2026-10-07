import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { listMessages } from '@/server/services/email';

export const GET = route(
  { scope: 'ANY', perm: ['email.send', 'email.manage', 'crm.email.send', 'crm.email.manage'], query: paginationQuery.extend({ campaignId: z.string().max(64).optional(), status: z.enum(['QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED']).optional(), q: z.string().trim().max(100).optional() }) },
  async ({ ctx, query }) => listMessages(ctx, query),
);
