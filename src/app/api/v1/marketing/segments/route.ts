import { route } from '@/server/api';
import { listSegments, saveSegment, segmentInput } from '@/server/services/marketing';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'] }, async ({ ctx }) => ({ rows: await listSegments(ctx) }));
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.email.manage', body: segmentInput }, async ({ ctx, body }) => saveSegment(ctx, null, body));
