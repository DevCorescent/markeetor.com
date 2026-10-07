import { creditSettingsSchema } from '@/lib/credits';
import { route } from '@/server/api';
import { getCreditSettings, saveCreditSettings } from '@/server/services/credits';

export const GET = route({ perm: 'marketplace.manage' }, async () => ({ settings: await getCreditSettings() }));
export const PUT = route({ perm: 'marketplace.manage', stepUp: true, body: creditSettingsSchema }, async ({ ctx, body }) => ({ settings: await saveCreditSettings(ctx, body) }));
