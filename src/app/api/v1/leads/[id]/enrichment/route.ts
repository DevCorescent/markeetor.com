import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { applyEnrichment, enrichOne, enrichOptions, getEnrichment } from '@/server/services/enrichment';

export const GET = route({ scope: 'PLATFORM', perm: 'leads.read' }, async ({ params }) => ({ enrichment: await getEnrichment(idParam(params)) }));
/** Research one lead now (synchronous, ~5–30 s). */
export const POST = route({ scope: 'PLATFORM', perm: 'leads.enrich', body: enrichOptions, rate: { bucket: 'enrich-one', limit: 120, windowSec: 3600 } }, async ({ ctx, params, body }) => ({ enrichment: await enrichOne(ctx, idParam(params), body) }));
/** Apply the stored research to the lead record. */
export const PATCH = route({ scope: 'PLATFORM', perm: 'leads.enrich', body: z.object({ mode: z.enum(['empty', 'overwrite']) }) }, async ({ ctx, params, body }) => applyEnrichment(ctx, idParam(params), body.mode));
