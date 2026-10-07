import { route } from '@/server/api';
import { referralOverview } from '@/server/services/client-tools';

export const GET = route({ perm: 'marketplace.manage' }, async ({ ctx }) => referralOverview(ctx));
