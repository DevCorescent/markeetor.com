import { route } from '@/server/api';
import { historyQuery, listHistory } from '@/server/services/endpoints';

export const GET = route({ perm: ['email.send', 'email.manage'], query: historyQuery }, async ({ ctx, query }) => listHistory(ctx, query));
