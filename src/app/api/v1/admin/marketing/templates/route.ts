import { route } from '@/server/api';
import { libraryTemplateInput, listLibrary, saveLibraryTemplate } from '@/server/services/sequences';

export const GET = route({ perm: 'email.manage' }, async () => ({ rows: await listLibrary({ all: true }) }));
export const POST = route({ perm: 'email.manage', body: libraryTemplateInput }, async ({ ctx, body }) => saveLibraryTemplate(ctx, null, body));
