import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { setCompanyCin } from '@/server/services/enrichment';

/** Attach a company's CIN (found on ZaubaCorp/MCA): unlocks registry data and direct directory links. */
export const POST = route({ scope: 'PLATFORM', perm: 'leads.enrich', body: z.object({ cin: z.string().trim().min(8).max(30) }) }, async ({ ctx, params, body }) => ({ enrichment: await setCompanyCin(ctx, idParam(params), body.cin) }));
