import { idParam, route } from '@/server/api';
import { prisma } from '@/server/db';

export const DELETE = route({ scope: 'ANY', selfService: true }, async ({ ctx, params }) => {
  const res = await prisma.savedView.deleteMany({ where: { id: idParam(params), userId: ctx.user.id } });
  return { deleted: res.count };
});
