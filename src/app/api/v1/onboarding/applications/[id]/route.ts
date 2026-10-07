import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { getApplication, noteApplication } from '@/server/services/onboarding';

export const GET = route({ perm: 'onboarding.manage' }, async ({ params }) => getApplication(idParam(params)));
export const PATCH = route({ perm: 'onboarding.manage', body: z.object({ notes: z.string().trim().max(2000) }) }, async ({ ctx, params, body }) => noteApplication(ctx, idParam(params), body.notes));
