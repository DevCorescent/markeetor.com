import type { AuthContext } from '@/server/auth/context';
import { AppError } from '@/server/errors';
import { orgSettings } from '@/server/services/organizations';

export function assertFunnels(ctx: AuthContext) {
  if (orgSettings(ctx.org?.settings).features.funnels === false) throw new AppError('FORBIDDEN', 'Funnels are not enabled for this workspace');
}
