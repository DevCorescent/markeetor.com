import { route } from '@/server/api';
import { listSavedReports, saveReport, savedReportInput } from '@/server/services/reports';

export const GET = route({ scope: 'ANY', perm: ['analytics.read', 'crm.analytics.read'] }, async ({ ctx }) => ({ reports: await listSavedReports(ctx) }));
export const POST = route({ scope: 'ANY', perm: ['analytics.read', 'crm.analytics.read'], body: savedReportInput }, async ({ ctx, body }) => saveReport(ctx, null, body));
