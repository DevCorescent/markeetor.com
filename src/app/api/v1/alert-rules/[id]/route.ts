import { idParam, route } from '@/server/api';
import { alertRuleInput, deleteAlertRule, saveAlertRule } from '@/server/services/alerts-admin';

export const PUT = route({ perm: 'marketplace.manage', body: alertRuleInput }, async ({ ctx, params, body }) => saveAlertRule(ctx, idParam(params), body));
export const DELETE = route({ perm: 'marketplace.manage' }, async ({ ctx, params }) => deleteAlertRule(ctx, idParam(params)));
