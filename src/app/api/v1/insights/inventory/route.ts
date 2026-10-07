import { route } from '@/server/api';
import { inventoryInsights } from '@/server/services/insights';

export const GET = route({ perm: 'analytics.read' }, async () => inventoryInsights());
