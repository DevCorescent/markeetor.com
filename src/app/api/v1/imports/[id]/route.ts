import { idParam, route } from '@/server/api';
import { getImport, IMPORT_FIELDS } from '@/server/services/imports';

export const GET = route({ perm: 'imports.read' }, async ({ params }) => ({ ...(await getImport(idParam(params))), fields: IMPORT_FIELDS.map(({ key, label }) => ({ key, label })) }));
