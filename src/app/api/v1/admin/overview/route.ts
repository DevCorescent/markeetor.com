import { route } from '@/server/api';
import { platformOverview, rangeSchema } from '@/server/services/analytics';

export const GET = route({ perm: 'platform.dashboard.view', query: rangeSchema }, async ({ query }) => platformOverview(query));
