import { z } from 'zod';
import { selectionSchema } from '@/lib/filters';
import { route } from '@/server/api';
import { selectionInsight } from '@/server/services/distribution';

/** What a selection contains and how it fits each client — powers the guided distribution wizard. */
export const POST = route(
  { perm: 'distribution.create', body: z.object({ selection: selectionSchema, includeInvalid: z.boolean().default(false) }), rate: { bucket: 'dist-insight', limit: 120, windowSec: 60 } },
  async ({ body }) => selectionInsight(body),
);
