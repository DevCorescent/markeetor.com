import { z } from 'zod';
import { route } from '@/server/api';
import { AppError } from '@/server/errors';
import { creditSummary } from '@/server/services/credits';

/** A workspace's credit balance and purchase options (platform staff pass ?organizationId=). */
export const GET = route(
  { scope: 'ANY', perm: ['crm.billing.view', 'crm.marketplace.view', 'marketplace.manage'], query: z.object({ organizationId: z.string().max(64).optional() }) },
  async ({ ctx, query }) => {
    if (ctx.scope === 'PLATFORM' && !query.organizationId) throw new AppError('VALIDATION_FAILED', 'organizationId is required');
    return creditSummary(ctx, ctx.scope === 'PLATFORM' ? query.organizationId! : ctx.orgId!);
  },
);
