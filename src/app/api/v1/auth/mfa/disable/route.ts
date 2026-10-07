import { z } from 'zod';
import { route } from '@/server/api';
import { disableMfa } from '@/server/services/auth';

export const POST = route(
  { scope: 'ANY', selfService: true, body: z.object({ code: z.string().min(6).max(8) }) },
  async ({ ctx, body }) => {
    await disableMfa(ctx, body.code);
    return { ok: true };
  },
);
