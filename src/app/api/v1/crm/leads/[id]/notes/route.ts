import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { addNote } from '@/server/services/crm';

export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.notes.write', body: z.object({ body: z.string().trim().min(1).max(10_000), pinned: z.boolean().default(false) }) },
  async ({ ctx, params, body }) => addNote(ctx, idParam(params), body.body, body.pinned),
);
