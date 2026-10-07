import { z } from 'zod';
import { route } from '@/server/api';
import { assertCan } from '@/server/auth/context';
import { archiveClientLeads, assignOwner, bulkSetStatus, tagClientLeads } from '@/server/services/crm';

const ids = z.array(z.string().max(64)).min(1).max(500);
const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign'), ids, ownerId: z.string().max(64).nullable() }),
  z.object({ action: z.literal('status'), ids, status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'NEGOTIATION', 'CONVERTED', 'LOST']), lostReason: z.string().trim().max(300).optional() }),
  z.object({ action: z.literal('archive'), ids }),
  z.object({ action: z.literal('restore'), ids }),
  z.object({ action: z.literal('tag'), ids, add: z.array(z.string().trim().min(1).max(40)).max(20).default([]), remove: z.array(z.string().max(64)).max(50).default([]) }),
]);

export const POST = route({ scope: 'ORGANIZATION', perm: ['crm.leads.bulk', 'crm.leads.assign', 'crm.leads.archive', 'crm.leads.update'], body }, async ({ ctx, body }) => {
  switch (body.action) {
    case 'assign':
      assertCan(ctx, 'crm.leads.assign');
      return assignOwner(ctx, body.ids, body.ownerId);
    case 'status':
      if (body.ids.length > 1) assertCan(ctx, 'crm.leads.bulk');
      assertCan(ctx, 'crm.leads.update');
      return bulkSetStatus(ctx, body.ids, body.status, body.lostReason);
    case 'archive':
    case 'restore':
      assertCan(ctx, 'crm.leads.archive');
      return archiveClientLeads(ctx, body.ids, body.action === 'archive');
    case 'tag':
      assertCan(ctx, 'crm.leads.update');
      return tagClientLeads(ctx, body.ids, body.add, body.remove);
  }
});
