import { route } from '@/server/api';
import { createLink, linkInput, listLinks } from '@/server/services/capture';

export const GET = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'] }, async ({ ctx }) => ({ rows: await listLinks(ctx), base: `${process.env.APP_URL ?? ''}/l/` }));
export const POST = route({ scope: 'ORGANIZATION', perm: ['crm.email.send', 'crm.email.manage'], body: linkInput }, async ({ ctx, body }) => createLink(ctx, body));
