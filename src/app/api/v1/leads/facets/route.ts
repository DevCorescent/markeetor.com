import { route } from '@/server/api';
import { leadFacets } from '@/server/services/leads';

export const GET = route({ perm: ['leads.read', 'distribution.read'] }, async () => leadFacets());
