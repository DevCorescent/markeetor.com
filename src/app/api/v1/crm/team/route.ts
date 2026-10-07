import { route } from '@/server/api';
import { teamOverview } from '@/server/services/crm';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.team.read', 'crm.users.manage'] }, async ({ ctx }) => teamOverview(ctx));
