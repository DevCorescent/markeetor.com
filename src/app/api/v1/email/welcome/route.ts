import { route } from '@/server/api';
import { saveWelcomeSettings, welcomeOverview, welcomeSettingsSchema } from '@/server/services/welcome';

export const GET = route({ perm: 'email.manage' }, async ({ ctx }) => welcomeOverview(ctx));
export const PUT = route({ perm: 'email.manage', body: welcomeSettingsSchema, rate: { bucket: 'welcome-save', limit: 60, windowSec: 3600 } }, async ({ ctx, body }) => ({ settings: await saveWelcomeSettings(ctx, body) }));
