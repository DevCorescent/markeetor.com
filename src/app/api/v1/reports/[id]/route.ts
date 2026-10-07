import { idParam, route } from '@/server/api';
import { deleteReport, saveReport, savedReportInput } from '@/server/services/reports';

export const PUT = route({ scope: 'ANY', perm: ['analytics.read', 'crm.analytics.read'], body: savedReportInput }, async ({ ctx, params, body }) => saveReport(ctx, idParam(params), body));
export const DELETE = route({ scope: 'ANY', perm: ['analytics.read', 'crm.analytics.read'] }, async ({ ctx, params }) => {
  await deleteReport(ctx, idParam(params));
  return { ok: true };
});
