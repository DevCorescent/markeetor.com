import { marketingSettingsSchema } from '@/lib/marketing';
import { route } from '@/server/api';
import { channelReady, getMarketing, saveMarketing } from '@/server/services/marketing';

export const GET = route({ perm: 'email.manage' }, async () => {
  const s = await getMarketing();
  return { settings: s, env: { whatsapp: channelReady({ ...s, providers: { ...s.providers, whatsapp: 'cloud' } }, 'WHATSAPP').live, whatsappWebhook: Boolean(process.env.WHATSAPP_APP_SECRET && process.env.WHATSAPP_VERIFY_TOKEN), sms: channelReady({ ...s, providers: { ...s.providers, sms: 'twilio' } }, 'SMS').live, ai: Boolean(process.env.AI_PROVIDER_API_KEY) } };
});
export const PUT = route({ perm: 'email.manage', stepUp: true, body: marketingSettingsSchema }, async ({ ctx, body }) => ({ settings: await saveMarketing(ctx, body) }));
