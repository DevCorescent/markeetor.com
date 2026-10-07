import { route } from '@/server/api';
import { getBranding } from '@/server/branding';
import { brandAssetLimits } from '@/server/services/branding';

export const GET = route({ perm: 'system.manage' }, async () => ({ branding: await getBranding(), limits: brandAssetLimits }));
