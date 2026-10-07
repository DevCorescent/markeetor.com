import { route } from '@/server/api';
import { alertRuleInput, measure } from '@/server/services/alerts-admin';

/** What a rule would alert on right now (nothing is sent). */
export const POST = route({ perm: 'marketplace.manage', body: alertRuleInput, rate: { bucket: 'alert-preview', limit: 60, windowSec: 600 } }, async ({ body }) => ({ hits: (await measure(body.metric, body.threshold, body.params)).slice(0, 20) }));
