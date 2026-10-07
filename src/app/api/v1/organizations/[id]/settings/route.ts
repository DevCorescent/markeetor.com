import { idParam, route } from '@/server/api';
import { settingsInput, updateOrgSettings } from '@/server/services/organizations';

export const PUT = route({ perm: 'orgs.update', body: settingsInput }, async ({ ctx, params, body }) => updateOrgSettings(ctx, idParam(params), body));
