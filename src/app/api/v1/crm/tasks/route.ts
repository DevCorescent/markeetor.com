import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { createTask, listTasks, taskInput } from '@/server/services/crm';

export const GET = route(
  {
    scope: 'ORGANIZATION',
    perm: ['crm.tasks.manage', 'crm.tasks.read_all'],
    query: paginationQuery.extend({
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
      scope: z.enum(['mine', 'team', 'delegated']).default('mine'),
      status: z.enum(['open', 'done', 'overdue', 'all']).default('open'),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      assigneeId: z.string().max(64).optional(),
    }),
  },
  async ({ ctx, query }) => listTasks(ctx, query),
);
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.tasks.manage', body: taskInput }, async ({ ctx, body }) => createTask(ctx, body));
