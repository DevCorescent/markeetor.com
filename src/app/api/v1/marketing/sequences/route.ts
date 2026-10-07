import { sequenceInput } from '@/lib/marketing';
import { route } from '@/server/api';
import { listSequences, saveSequence } from '@/server/services/sequences';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'] }, async ({ ctx }) => ({ rows: await listSequences(ctx) }));
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.email.manage', body: sequenceInput }, async ({ ctx, body }) => saveSequence(ctx, null, body));
