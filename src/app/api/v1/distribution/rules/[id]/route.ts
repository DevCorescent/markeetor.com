import { idParam, route } from '@/server/api';
import { audit } from '@/server/audit';
import { withPlatform } from '@/server/db';
import { AppError } from '@/server/errors';
import { ruleInput, upsertRule } from '@/server/services/distribution';

export const PUT = route({ perm: 'distribution.rules', body: ruleInput }, async ({ ctx, params, body }) => upsertRule(ctx, idParam(params), body));
export const DELETE = route({ perm: 'distribution.rules' }, async ({ ctx, params }) => {
  const id = idParam(params);
  await withPlatform(async (tx) => {
    const r = await tx.distributionRule.findUnique({ where: { id } });
    if (!r) return;
    if (r.enabled) throw new AppError('CONFLICT', 'Disable the rule before deleting it');
    await tx.distributionRule.delete({ where: { id } });
    await audit(tx, ctx, { action: 'distribution.rule.deleted', targetType: 'distribution_rule', targetId: id, organizationId: null, before: { name: r.name } });
  });
  return { ok: true };
});
