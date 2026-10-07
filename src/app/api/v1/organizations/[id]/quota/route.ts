import { idParam, route } from '@/server/api';
import { quotaInput, updateQuota } from '@/server/services/organizations';

export const PUT = route({ perm: 'orgs.quotas', body: quotaInput }, async ({ ctx, params, body }) => updateQuota(ctx, idParam(params), body));
