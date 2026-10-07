import { growthSettingsSchema } from '@/lib/growth';
import { route } from '@/server/api';
import { getGrowth, saveGrowth } from '@/server/services/saved-searches';

export const GET = route({ perm: 'marketplace.manage' }, async () => ({ settings: await getGrowth() }));
export const PUT = route({ perm: 'marketplace.manage', stepUp: true, body: growthSettingsSchema }, async ({ ctx, body }) => ({ settings: await saveGrowth(ctx, body) }));
