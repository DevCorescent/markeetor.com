import { route } from '@/server/api';
import { aiWrite, writeInput } from '@/server/services/marketing';

export const POST = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'], body: writeInput, rate: { bucket: 'ai-write', limit: 60, windowSec: 3600 } }, async ({ ctx, body }) => aiWrite(ctx, body));
