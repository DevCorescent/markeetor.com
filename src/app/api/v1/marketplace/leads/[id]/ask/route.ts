import { idParam, route } from '@/server/api';
import { askAboutCompany, askInput } from '@/server/services/company-ask';

/** Ask AI about a marketplace lead's company — company basics only, never people or contact details. */
export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.marketplace.view', body: askInput, rate: { bucket: 'company-ask', limit: 30, windowSec: 60 } },
  async ({ ctx, params, body }) => askAboutCompany(ctx, idParam(params), body),
);
