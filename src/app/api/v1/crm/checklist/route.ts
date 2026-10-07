import { route } from '@/server/api';
import { onboardingChecklist } from '@/server/services/client-tools';

export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.dashboard.view' }, async ({ ctx }) => onboardingChecklist(ctx));
