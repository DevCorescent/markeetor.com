import { route } from '@/server/api';
import { enrichmentOverview } from '@/server/services/enrichment';

export const GET = route({ scope: 'PLATFORM', perm: ['leads.enrich', 'leads.read'] }, async () => enrichmentOverview());
