import { z } from 'zod';
import { selectionSchema } from '@/lib/filters';
import { route } from '@/server/api';
import { assertCan } from '@/server/auth/context';
import { archiveLeads, tagLeads } from '@/server/services/leads';

const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('archive'), selection: selectionSchema, reason: z.string().trim().min(3).max(300) }),
  z.object({ action: z.literal('restore'), selection: selectionSchema, reason: z.string().trim().max(300).default('Restored') }),
  z.object({ action: z.literal('tag'), selection: selectionSchema, add: z.array(z.string().trim().min(1).max(40)).max(20).default([]), remove: z.array(z.string().max(64)).max(50).default([]) }),
]);

export const POST = route({ perm: ['leads.archive', 'leads.update'], body }, async ({ ctx, body }) => {
  if (body.action === 'tag') {
    assertCan(ctx, 'leads.update');
    return tagLeads(ctx, body.selection, body.add, body.remove);
  }
  assertCan(ctx, 'leads.archive');
  return archiveLeads(ctx, body.selection, body.action === 'archive', body.reason);
});
