import { route } from '@/server/api';
import { newWebhookSecret } from '@/server/services/workspace-automation';

export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.settings.manage' }, async () => ({ secret: newWebhookSecret() }));
