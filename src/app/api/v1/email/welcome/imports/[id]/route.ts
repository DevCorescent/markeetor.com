import { idParam, route } from '@/server/api';
import { sendWelcomeForImport } from '@/server/services/welcome';

/** Sends welcome emails for one completed import right away (also for imports from before the feature was on). */
export const POST = route({ perm: 'email.manage', rate: { bucket: 'welcome-send', limit: 30, windowSec: 3600 } }, async ({ ctx, params }) => sendWelcomeForImport(ctx, idParam(params)));
