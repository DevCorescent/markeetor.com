import type { FormConfig } from '@/lib/onboarding';
import { route } from '@/server/api';
import { withPlatform } from '@/server/db';
import { AppError } from '@/server/errors';
import { finderInput, publicFinderTurn } from '@/server/services/lead-finder';

/** Lead Finder on a public form: aggregate counts only, and only when the form enables it. */
export const POST = route({ auth: 'public', body: finderInput, rate: { bucket: 'public-finder', limit: 40, windowSec: 60, by: 'ip' } }, async ({ body, params, ctx }) => {
  const f = await withPlatform((tx) => tx.onboardingForm.findUnique({ where: { slug: params.slug }, select: { status: true, config: true } }));
  const enabled = (f?.config as FormConfig | undefined)?.settings?.leadFinder?.enabled;
  if (!f || !enabled || (f.status !== 'PUBLISHED' && !ctx?.permissions.has('onboarding.manage'))) throw new AppError('NOT_FOUND', 'Not available');
  return publicFinderTurn(body);
});
