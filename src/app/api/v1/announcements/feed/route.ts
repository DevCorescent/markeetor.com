import { route } from '@/server/api';
import { announcementsFor } from '@/server/services/announcements';

export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.dashboard.view' }, async ({ ctx }) => ({ announcements: await announcementsFor(ctx.orgId!) }));
