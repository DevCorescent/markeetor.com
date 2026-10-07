import { z } from 'zod';
import { idParam, route } from '@/server/api';
import { orgTimeline } from '@/server/services/health';

export const GET = route({ perm: 'orgs.read', query: z.object({ before: z.string().datetime().optional() }) }, async ({ params, query }) => orgTimeline(idParam(params), { before: query.before ? new Date(query.before) : undefined }));
