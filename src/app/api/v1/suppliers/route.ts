import { z } from 'zod';
import { route } from '@/server/api';
import { saveSupplier, supplierInput, supplierPerformance } from '@/server/services/suppliers';

export const GET = route({ perm: 'marketplace.manage', query: z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90, 180, 365].includes(d)).default(30) }) }, async ({ query }) => supplierPerformance({ days: query.days }));
export const POST = route({ perm: 'marketplace.manage', body: supplierInput }, async ({ ctx, body }) => saveSupplier(ctx, null, body));
