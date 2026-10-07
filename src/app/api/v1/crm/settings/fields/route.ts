import { route } from '@/server/api';
import { fieldInput, saveCustomFields } from '@/server/services/crm';

export const PUT = route({ scope: 'ORGANIZATION', perm: 'crm.settings.manage', body: fieldInput }, async ({ ctx, body }) => saveCustomFields(ctx, body));
