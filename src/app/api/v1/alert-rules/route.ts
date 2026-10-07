import { route } from '@/server/api';
import { alertRuleInput, listAlertRules, saveAlertRule } from '@/server/services/alerts-admin';

export const GET = route({ perm: 'marketplace.manage' }, async () => listAlertRules());
export const POST = route({ perm: 'marketplace.manage', body: alertRuleInput }, async ({ ctx, body }) => saveAlertRule(ctx, null, body));
