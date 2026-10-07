import { route } from '@/server/api';
import { enrichmentPolicyInput, saveEnrichmentPolicy } from '@/server/services/enrichment';

export const PUT = route({ scope: 'PLATFORM', perm: 'leads.enrich', body: enrichmentPolicyInput }, async ({ ctx, body }) => saveEnrichmentPolicy(ctx, body));
