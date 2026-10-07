import { idParam, route } from '@/server/api';
import { getBatch } from '@/server/services/distribution';

export const GET = route({ perm: 'distribution.read' }, async ({ params }) => getBatch(idParam(params)));
