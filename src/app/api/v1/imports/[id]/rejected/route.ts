import { idParam, route } from '@/server/api';
import { failedRowsCsv } from '@/server/services/imports';

/** Rejected-row report for correction and re-import. Contains the uploader's original data, so it requires imports.create. */
export const GET = route({ perm: 'imports.create', rate: { bucket: 'import-rejected', limit: 20, windowSec: 3600 } }, async ({ ctx, params }) => {
  const { csv, fileName } = await failedRowsCsv(ctx, idParam(params));
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${fileName}"`, 'cache-control': 'no-store' } });
});
