import { paginationQuery, route } from '@/server/api';
import { AppError } from '@/server/errors';
import { orgSettings } from '@/server/services/organizations';
import { campaignInput, createCampaign, listCampaigns } from '@/server/services/email';

export const GET = route({ scope: 'ANY', perm: ['email.send', 'email.manage', 'crm.email.send', 'crm.email.manage'], query: paginationQuery }, async ({ ctx, query }) => listCampaigns(ctx, query));
export const POST = route({ scope: 'ANY', perm: ['email.send', 'crm.email.send'], body: campaignInput, rate: { bucket: 'campaign-create', limit: 60, windowSec: 3600 } }, async ({ ctx, body }) => {
  if (ctx.scope === 'ORGANIZATION' && !orgSettings(ctx.org?.settings).features.email) throw new AppError('FORBIDDEN', 'Email is not enabled for this workspace');
  return createCampaign(ctx, body);
});
