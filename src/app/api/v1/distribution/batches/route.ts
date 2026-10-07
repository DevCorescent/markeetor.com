import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { createDistribution, createInput, listBatches } from '@/server/services/distribution';

export const GET = route(
  { perm: 'distribution.read', apiKey: true, query: paginationQuery.extend({ status: z.string().max(20).optional(), organizationId: z.string().max(64).optional() }) },
  async ({ query }) => listBatches(query),
);

export const POST = route({ perm: 'distribution.create', body: createInput, rate: { bucket: 'dist-create', limit: 60, windowSec: 3600 } }, async ({ ctx, body }) => {
  const res = await createDistribution(ctx, body);
  return { batch: res.batch, duplicate: res.duplicate };
});
