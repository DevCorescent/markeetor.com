import { idParam, route } from '@/server/api';
import { getUserDetail } from '@/server/services/users';

export const GET = route({ perm: 'users.read' }, async ({ ctx, params }) => getUserDetail(ctx, idParam(params)));
