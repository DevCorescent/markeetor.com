import { idParam, route } from '@/server/api';
import { testWebhook } from '@/server/services/workspace-automation';

export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.settings.manage', rate: { bucket: 'webhook-test', limit: 20, windowSec: 3600, by: 'org' } }, async ({ ctx, params }) => testWebhook(ctx, idParam(params)));
