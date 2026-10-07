import { route } from '@/server/api';
import { marketplaceOverview } from '@/server/services/marketplace';

export const GET = route({ perm: 'marketplace.manage' }, async () => marketplaceOverview());
