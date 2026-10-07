import { route } from '@/server/api';

export const GET = route({ auth: 'session-any', scope: 'ANY', selfService: true }, async ({ ctx }) => ({
  user: ctx.user,
  scope: ctx.scope,
  organization: ctx.org ? { id: ctx.org.id, name: ctx.org.name, code: ctx.org.code } : null,
  role: ctx.role,
  permissions: [...ctx.permissions].sort(),
  mfaPending: ctx.session?.mfaPending ?? false,
  restriction: ctx.restriction,
}));
