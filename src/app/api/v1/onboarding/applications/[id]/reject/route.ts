import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { rejectApplication } from '@/server/services/onboarding';

export const POST = route({ perm: 'onboarding.manage', body: z.object({ reason: z.string().trim().min(3).max(1000), notify: z.boolean().default(true), spam: z.boolean().default(false) }) }, async ({ ctx, params, body }) => rejectApplication(ctx, idParam(params), body));
