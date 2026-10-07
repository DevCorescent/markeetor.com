import { idParam, route } from '@/server/api';
import { getOrganization, orgInput, updateOrganization } from '@/server/services/organizations';

export const GET = route({ perm: 'orgs.read' }, async ({ params }) => getOrganization(idParam(params)));
export const PATCH = route({ perm: 'orgs.update', body: orgInput }, async ({ ctx, params, body }) => updateOrganization(ctx, idParam(params), body));
