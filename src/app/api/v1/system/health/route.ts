import { route } from '@/server/api';
import { systemHealth } from '@/server/services/system-health';

export const GET = route({ perm: 'system.manage' }, async () => systemHealth());
