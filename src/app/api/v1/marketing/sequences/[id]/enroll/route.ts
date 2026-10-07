import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { enroll } from '@/server/services/sequences';

export const POST = route(
  { scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'], body: z.object({ clientLeadIds: z.array(z.string().max(64)).max(5000).optional(), segmentId: z.string().max(64).optional() }).refine((x) => x.clientLeadIds?.length || x.segmentId, 'Choose leads or a segment') },
  async ({ ctx, params, body }) => enroll(ctx, idParam(params), body),
);
