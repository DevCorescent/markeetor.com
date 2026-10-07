import { route } from '@/server/api';
import { savePipelineStages, stageInput } from '@/server/services/crm';

export const PUT = route({ scope: 'ORGANIZATION', perm: 'crm.pipeline.manage', body: stageInput }, async ({ ctx, body }) => savePipelineStages(ctx, body));
