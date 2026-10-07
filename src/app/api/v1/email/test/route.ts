import { z } from 'zod';
import { route } from '@/server/api';
import type { EmailDesign } from '@/lib/email/types';
import { designSchema, sendTest } from '@/server/services/email';

export const POST = route(
  { scope: 'ANY', perm: ['email.send', 'email.manage', 'crm.email.send', 'crm.email.manage'], body: z.object({ smtpAccountId: z.string().max(64), to: z.string().trim().email().max(254), subject: z.string().max(300), preheader: z.string().max(300).nullable().optional(), design: designSchema }) },
  async ({ ctx, body }) => sendTest(ctx, { ...body, design: body.design as EmailDesign }),
);
