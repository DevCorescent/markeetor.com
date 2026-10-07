import { route } from '@/server/api';
import { submitCapture, submitCaptureForm } from '@/server/services/capture';

/** Public lead-capture submission (hosted or embedded form). Rate-limited per IP. */
export const POST = route({ auth: 'public', body: submitCapture, rate: { bucket: 'capture-submit', limit: 20, windowSec: 3600, by: 'ip' } }, async ({ body, params, meta }) =>
  submitCaptureForm(params.slug, body, { ip: meta.ip }));
