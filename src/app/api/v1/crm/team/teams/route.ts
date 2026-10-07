import { route } from '@/server/api';
import { teamInput, upsertTeam } from '@/server/services/crm';

export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.team.manage', body: teamInput }, async ({ ctx, body }) => upsertTeam(ctx, null, body));
