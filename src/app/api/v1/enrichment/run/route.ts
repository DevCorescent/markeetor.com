import { route } from '@/server/api';
import { bulkEnrichInput, queueEnrichment } from '@/server/services/enrichment';

/** Bulk research: queues the selection; progress shows in Lead repository → Enrichment. */
export const POST = route({ scope: 'PLATFORM', perm: 'leads.enrich', body: bulkEnrichInput, rate: { bucket: 'enrich-bulk', limit: 20, windowSec: 3600 } }, async ({ ctx, body }) => queueEnrichment(ctx, body));
