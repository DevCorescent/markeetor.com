import { route } from '@/server/api';
import { cancelEnrichment } from '@/server/services/enrichment';

export const POST = route({ scope: 'PLATFORM', perm: 'leads.enrich' }, async ({ ctx, params }) => cancelEnrichment(ctx, String(params.id).slice(0, 64)));
