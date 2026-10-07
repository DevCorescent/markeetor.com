import { route } from '@/server/api';
import { can } from '@/server/auth/context';
import { clientDashboard } from '@/server/services/analytics';

export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.dashboard.view' }, async ({ ctx }) =>
  clientDashboard(ctx.orgId!, { userId: ctx.user.id, ownOnly: !can(ctx, 'crm.leads.read_all') }),
);
