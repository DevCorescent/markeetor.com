import { idParam, route } from '@/server/api';
import { disputeEligibility, reportInput, reportLead } from '@/server/services/disputes';

const perm = ['crm.leads.update', 'crm.marketplace.request'] as const;
export const GET = route({ scope: 'ORGANIZATION', perm: [...perm] }, async ({ ctx, params }) => disputeEligibility(ctx, idParam(params)));
export const POST = route({ scope: 'ORGANIZATION', perm: [...perm], body: reportInput, rate: { bucket: 'dispute', limit: 30, windowSec: 3600, by: 'org' } }, async ({ ctx, params, body }) => reportLead(ctx, idParam(params), body));
