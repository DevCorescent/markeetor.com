import { z } from 'zod';
import { QUEUE_NAMES } from '@/server/jobs/queues';
import { route } from '@/server/api';
import { retryAllFailed, retryFailedJob } from '@/server/services/system-health';

export const POST = route(
  { perm: 'system.manage', body: z.object({ queue: z.enum(QUEUE_NAMES), id: z.string().max(100).optional() }) },
  async ({ ctx, body }) => (body.id ? retryFailedJob(ctx, body.queue, body.id) : retryAllFailed(ctx, body.queue)),
);
