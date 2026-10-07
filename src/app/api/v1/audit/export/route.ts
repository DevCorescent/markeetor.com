import { z } from 'zod';
import { route } from '@/server/api';
import { auditQuery, exportAudit } from '@/server/services/governance';

export const POST = route({ perm: 'audit.export', stepUp: true, rate: { bucket: 'audit-export', limit: 10, windowSec: 3600 }, body: z.object({ filter: auditQuery, reason: z.string().trim().min(5).max(300) }) }, async ({ ctx, body }) => {
  const { csv } = await exportAudit(ctx, body.filter, body.reason);
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store' } });
});
