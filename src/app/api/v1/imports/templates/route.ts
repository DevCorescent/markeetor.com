import { route } from '@/server/api';
import { withPlatform } from '@/server/db';

export const GET = route({ perm: 'imports.read' }, async () => ({ templates: await withPlatform((tx) => tx.importTemplate.findMany({ orderBy: { name: 'asc' } })) }));
