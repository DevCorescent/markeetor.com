import { z } from 'zod';
import { route } from '@/server/api';
import { getSetting } from '@/server/settings';
import { catalogHeadline } from '@/server/services/lead-finder';
import { setHomepage } from '@/server/services/onboarding';

export const GET = route({ scope: 'PLATFORM', perm: 'onboarding.manage' }, async () => ({ ...(await getSetting('homepage')), headline: await catalogHeadline() }));
export const PUT = route({ scope: 'PLATFORM', perm: 'onboarding.manage', body: z.object({ formId: z.string().max(64).nullable() }) }, async ({ ctx, body }) => setHomepage(ctx, body.formId));
