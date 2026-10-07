import { route } from '@/server/api';
import { systemHealth } from '@/server/services/analytics';

export const GET = route({ perm: ['platform.dashboard.view', 'system.manage'] }, async () => systemHealth());
