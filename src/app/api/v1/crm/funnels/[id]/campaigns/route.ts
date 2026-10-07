import { idParam, route } from '@/server/api';
import { launchFunnelCampaign, launchInput } from '@/server/services/funnels';
import { assertFunnels } from '../../guard';

export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.funnels.manage', body: launchInput, rate: { bucket: 'funnel-campaign', limit: 30, windowSec: 3600 } }, async ({ ctx, params, body }) => {
  assertFunnels(ctx);
  return launchFunnelCampaign(ctx, idParam(params), body);
});
