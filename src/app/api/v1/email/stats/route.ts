import { route } from '@/server/api';
import { emailStats } from '@/server/services/email';

export const GET = route({ scope: 'ANY', perm: ['email.send', 'email.manage', 'crm.email.send', 'crm.email.manage'] }, async ({ ctx }) => emailStats(ctx));
