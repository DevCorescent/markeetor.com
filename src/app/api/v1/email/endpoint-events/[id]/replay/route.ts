import { idParam, route } from '@/server/api';
import { replayEvent } from '@/server/services/endpoints';

export const POST = route({ perm: 'email.manage', rate: { bucket: 'endpoint-replay', limit: 120, windowSec: 3600 } }, async ({ ctx, params }) => replayEvent(ctx, idParam(params)));
