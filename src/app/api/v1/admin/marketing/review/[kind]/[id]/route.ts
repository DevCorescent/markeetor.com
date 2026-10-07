import { z } from 'zod';
import { route } from '@/server/api';
import { AppError } from '@/server/errors';
import { reviewForm } from '@/server/services/capture';
import { cancelBroadcast, reviewBroadcast } from '@/server/services/marketing';

/** Approve / reject a capture form or broadcast held for review (or stop a running broadcast). */
export const POST = route({ perm: 'email.manage', body: z.object({ action: z.enum(['approve', 'reject', 'stop']), note: z.string().trim().max(500).optional() }) }, async ({ ctx, params, body }) => {
  const { kind, id } = params as { kind: string; id: string };
  if (kind === 'forms' && body.action !== 'stop') return reviewForm(ctx, id, body.action === 'approve', body.note);
  if (kind === 'broadcasts') return body.action === 'stop' ? cancelBroadcast(ctx, id) : reviewBroadcast(ctx, id, body.action === 'approve', body.note);
  throw new AppError('VALIDATION_FAILED', 'Unknown review item');
});
