import { idParam, route } from '@/server/api';
import { useLibrarySequence } from '@/server/services/sequences';

export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.email.manage' }, async ({ ctx, params }) => useLibrarySequence(ctx, idParam(params)));
