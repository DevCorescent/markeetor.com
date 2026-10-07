import { z } from 'zod';
import { route } from '@/server/api';
import { audienceSchema, previewAudience } from '@/server/services/email';

export const POST = route({ scope: 'ANY', perm: ['email.send', 'crm.email.send'], body: z.object({ audience: audienceSchema }), rate: { bucket: 'audience-preview', limit: 120, windowSec: 600 } }, async ({ ctx, body }) => previewAudience(ctx, body.audience));
