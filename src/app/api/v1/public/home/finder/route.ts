import { route } from '@/server/api';
import { AppError } from '@/server/errors';
import { finderInput, homeFinderTurn } from '@/server/services/lead-finder';
import { homeFinderSettings } from '@/server/services/onboarding';

/** The homepage Lead Finder: aggregates and masked previews only; available while the homepage is in finder mode. */
export const POST = route({ auth: 'public', body: finderInput, rate: { bucket: 'home-finder', limit: 30, windowSec: 60, by: 'ip' } }, async ({ body, ctx }) => {
  const s = await homeFinderSettings(ctx ?? null);
  if (!s) throw new AppError('NOT_FOUND', 'Not available');
  return homeFinderTurn(body, s);
});
