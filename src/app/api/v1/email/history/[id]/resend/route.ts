import { idParam, route } from '@/server/api';
import { resendMessage } from '@/server/services/endpoints';

export const POST = route({ perm: 'email.manage', rate: { bucket: 'email-resend', limit: 200, windowSec: 3600 } }, async ({ ctx, params }) => resendMessage(ctx, idParam(params)));
