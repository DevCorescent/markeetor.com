import { route } from '@/server/api';
import { platformAnalytics, rangeSchema } from '@/server/services/analytics';

export const GET = route({ perm: 'analytics.read', apiKey: true, query: rangeSchema }, async ({ query }) => platformAnalytics(query));
