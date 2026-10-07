import { route } from '@/server/api';
import { withPlatform } from '@/server/db';
import { ruleInput, upsertRule } from '@/server/services/distribution';

export const GET = route({ perm: ['distribution.rules', 'distribution.read'] }, async () => ({ rules: await withPlatform((tx) => tx.distributionRule.findMany({ orderBy: { createdAt: 'desc' } })) }));
export const POST = route({ perm: 'distribution.rules', body: ruleInput }, async ({ ctx, body }) => upsertRule(ctx, null, body));
