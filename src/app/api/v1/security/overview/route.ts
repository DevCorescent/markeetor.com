import { route } from '@/server/api';
import { securityOverview } from '@/server/services/governance';

export const GET = route({ perm: 'security.read' }, async () => securityOverview());
