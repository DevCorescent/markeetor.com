import { route } from '@/server/api';
import { AppError } from '@/server/errors';
import { reportDefinition, runReport } from '@/server/services/analytics';

/** Runs a custom report. Workspace users are pinned to their own organization; the definition's orgIds are ignored. */
export const POST = route({ scope: 'ANY', perm: ['analytics.read', 'crm.analytics.read'], body: reportDefinition, rate: { bucket: 'report-run', limit: 120, windowSec: 600 } }, async ({ ctx, body }) => {
  try {
    return { rows: await runReport(body, ctx.scope === 'ORGANIZATION' ? ctx.orgId! : undefined) };
  } catch (e) {
    if (e instanceof Error && /not available/.test(e.message)) throw new AppError('VALIDATION_FAILED', e.message);
    throw e;
  }
});
