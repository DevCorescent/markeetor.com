import { idParam, route } from '@/server/api';
import { channelReady, marketingAccess } from '@/server/services/marketing';
import { leadEnrollments } from '@/server/services/sequences';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.leads.read_all', 'crm.leads.read_own'] }, async ({ ctx, params }) => {
  const { settings, features } = await marketingAccess(ctx.orgId!);
  return {
    rows: features.sequences ? await leadEnrollments(ctx, idParam(params)) : [],
    features,
    pricing: settings.pricing,
    channels: { whatsapp: features.whatsapp && channelReady(settings, 'WHATSAPP').ok, sms: features.sms && channelReady(settings, 'SMS').ok, liveWhatsapp: channelReady(settings, 'WHATSAPP').live, liveSms: channelReady(settings, 'SMS').live },
  };
});
