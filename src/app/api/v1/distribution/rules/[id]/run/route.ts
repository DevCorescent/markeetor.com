import { idParam, route } from '@/server/api';
import { runRule } from '@/server/services/distribution';

export const POST = route({ perm: ['distribution.rules'], rate: { bucket: 'rule-run', limit: 30, windowSec: 3600 } }, async ({ ctx, params }) => {
  const batch = await runRule(idParam(params), ctx);
  return { batch, message: batch ? `Created batch ${batch.code}` : 'No eligible leads matched this rule' };
});
