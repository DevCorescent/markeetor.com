import { route } from '@/server/api';
import { adjustCredits, adjustInput } from '@/server/services/credits';

/** Add or remove credits by hand (goodwill, corrections). Always audited with a reason. */
export const POST = route({ perm: 'marketplace.manage', stepUp: true, body: adjustInput }, async ({ ctx, body }) => adjustCredits(ctx, body));
