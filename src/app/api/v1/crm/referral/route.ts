import { route } from '@/server/api';
import { myReferral } from '@/server/services/client-tools';

export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.billing.view' }, async ({ ctx }) => myReferral(ctx));
