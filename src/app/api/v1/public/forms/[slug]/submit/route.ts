import { route } from '@/server/api';
import { submitApplication, submitInput } from '@/server/services/onboarding';

/** Public application endpoint. Rate-limited per IP; validation mirrors the form definition. */
export const POST = route({ auth: 'public', body: submitInput, rate: { bucket: 'onboarding-submit', limit: 8, windowSec: 3600, by: 'ip' } }, async ({ body, params, meta }) =>
  submitApplication(params.slug, body, { ip: meta.ip, userAgent: meta.userAgent }));
