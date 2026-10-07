import { idParam, route } from '@/server/api';
import { deleteTeam, teamInput, upsertTeam } from '@/server/services/crm';

export const PUT = route({ scope: 'ORGANIZATION', perm: 'crm.team.manage', body: teamInput }, async ({ ctx, params, body }) => upsertTeam(ctx, idParam(params), body));
export const DELETE = route({ scope: 'ORGANIZATION', perm: 'crm.team.manage' }, async ({ ctx, params }) => {
  await deleteTeam(ctx, idParam(params));
  return { ok: true };
});
