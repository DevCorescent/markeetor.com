import { route } from '@/server/api';
import { funnelTemplates } from '@/server/services/funnels';

export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.funnels.manage' }, async ({ ctx }) => ({ templates: await funnelTemplates(ctx) }));
