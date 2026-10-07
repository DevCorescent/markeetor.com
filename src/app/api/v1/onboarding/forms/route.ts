import { z } from 'zod';
import { route } from '@/server/api';
import { createForm, listForms } from '@/server/services/onboarding';

export const GET = route({ perm: 'onboarding.manage' }, async () => ({ forms: await listForms() }));
export const POST = route({ perm: 'onboarding.manage', body: z.object({ name: z.string().trim().min(2).max(80), copyFrom: z.string().max(64).nullable().optional() }) }, async ({ ctx, body }) => createForm(ctx, body));
