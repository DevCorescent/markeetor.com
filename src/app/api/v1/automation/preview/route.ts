import { route } from '@/server/api';
import { previewWorkflow, workflowInput } from '@/server/services/automation';

export const POST = route({ perm: 'automation.manage', body: workflowInput }, async ({ body }) => previewWorkflow(body));
