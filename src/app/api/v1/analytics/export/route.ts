import { route } from '@/server/api';
import { audit } from '@/server/audit';
import { withPlatform } from '@/server/db';
import { reportDefinition, runReport, REPORT_DIMENSIONS, REPORT_METRICS } from '@/server/services/analytics';
import { toCsv } from '@/server/services/normalize';

/** Exports an aggregated report (no lead-level data). Platform administrators only. */
export const POST = route({ perm: 'analytics.export', body: reportDefinition, rate: { bucket: 'analytics-export', limit: 20, windowSec: 3600 } }, async ({ ctx, body }) => {
  const rows = await runReport(body);
  await withPlatform((tx) => audit(tx, ctx, { action: 'analytics.exported', targetType: 'report', organizationId: null, metadata: { ...body, rows: rows.length } }));
  const csv = toCsv([[REPORT_DIMENSIONS[body.groupBy], REPORT_METRICS[body.metric]], ...rows.map((r) => [r.label, r.value])]);
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="report-${body.metric}-by-${body.groupBy}.csv"`, 'cache-control': 'no-store' } });
});
