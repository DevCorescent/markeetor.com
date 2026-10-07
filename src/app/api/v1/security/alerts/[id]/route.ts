import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { getAlert, updateAlert } from '@/server/services/governance';

export const GET = route({ perm: 'security.read' }, async ({ params }) => getAlert(idParam(params)));
export const PATCH = route(
  {
    perm: 'security.manage',
    body: z.object({
      status: z.enum(['OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED']).optional(),
      assigneeId: z.string().max(64).nullable().optional(),
      note: z.string().trim().max(4000).optional(),
      resolutionNote: z.string().trim().max(2000).optional(),
    }),
  },
  async ({ ctx, params, body }) => updateAlert(ctx, idParam(params), body),
);
