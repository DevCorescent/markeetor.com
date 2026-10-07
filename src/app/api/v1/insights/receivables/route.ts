import { route } from '@/server/api';
import { receivables } from '@/server/services/insights';

export const GET = route({ perm: ['analytics.read', 'marketplace.manage'] }, async () => receivables());
