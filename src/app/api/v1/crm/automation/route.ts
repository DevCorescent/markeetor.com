import { workspaceAutomationSchema } from '@/lib/growth';
import { route } from '@/server/api';
import { getAutomation, saveAutomation } from '@/server/services/workspace-automation';

export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.settings.manage' }, async ({ ctx }) => ({ automation: await getAutomation(ctx.orgId!) }));
export const PUT = route({ scope: 'ORGANIZATION', perm: 'crm.settings.manage', body: workspaceAutomationSchema }, async ({ ctx, body }) => ({ automation: await saveAutomation(ctx, body) }));
