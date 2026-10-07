import { route } from '@/server/api';
import { listLibrary } from '@/server/services/sequences';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'] }, async () => ({ rows: await listLibrary() }));
