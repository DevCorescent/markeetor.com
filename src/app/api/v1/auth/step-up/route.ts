import { z } from 'zod';
import { route } from '@/server/api';
import { stepUp } from '@/server/services/auth';

export const POST = route(
  { scope: 'ANY', selfService: true, body: z.object({ password: z.string().max(256).optional(), code: z.string().max(8).optional() }) },
  async ({ ctx, body }) => stepUp(ctx, body),
);
