import { route } from '@/server/api';
import { exportHistory, historyQuery } from '@/server/services/endpoints';

export const GET = route({ perm: ['email.send', 'email.manage'], query: historyQuery, rate: { bucket: 'email-history-export', limit: 20, windowSec: 3600 } }, async ({ ctx, query }) => {
  const csv = await exportHistory(ctx, query);
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="email-history-${new Date().toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store' } });
});
