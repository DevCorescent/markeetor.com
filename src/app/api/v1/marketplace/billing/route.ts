import { z } from 'zod';
import { route } from '@/server/api';
import { AppError } from '@/server/errors';
import { billingSummary } from '@/server/services/marketplace';

export const GET = route({ scope: 'ANY', perm: ['crm.billing.view', 'crm.marketplace.view', 'marketplace.manage'], query: z.object({ organizationId: z.string().max(64).optional() }) }, async ({ ctx, query }) => {
  if (ctx.scope === 'PLATFORM') {
    if (!query.organizationId) throw new AppError('VALIDATION_FAILED', 'organizationId is required');
    return billingSummary(ctx, query.organizationId);
  }
  return billingSummary(ctx);
});
