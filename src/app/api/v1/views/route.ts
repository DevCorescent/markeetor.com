import { z } from 'zod';
import { route } from '@/server/api';
import { prisma } from '@/server/db';

const scopeEnum = z.enum(['ADMIN_LEADS', 'CLIENT_LEADS', 'ADMIN_DASHBOARD', 'AUDIT']);

export const GET = route({ scope: 'ANY', selfService: true, query: z.object({ scope: scopeEnum }) }, async ({ ctx, query }) => ({
  views: await prisma.savedView.findMany({ where: { userId: ctx.user.id, scope: query.scope }, orderBy: { name: 'asc' } }),
}));

export const POST = route(
  { scope: 'ANY', selfService: true, body: z.object({ scope: scopeEnum, name: z.string().trim().min(1).max(60), state: z.record(z.string(), z.unknown()) }) },
  async ({ ctx, body }) => {
    if (JSON.stringify(body.state).length > 20_000) return new Response(JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'View is too large' } }), { status: 413 });
    return prisma.savedView.upsert({
      where: { userId_scope_name: { userId: ctx.user.id, scope: body.scope, name: body.name } },
      create: { userId: ctx.user.id, organizationId: ctx.orgId, scope: body.scope, name: body.name, state: body.state as object },
      update: { state: body.state as object },
    });
  },
);
