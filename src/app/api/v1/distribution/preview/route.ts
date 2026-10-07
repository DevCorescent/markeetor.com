import { route } from '@/server/api';
import { planInput, previewDistribution } from '@/server/services/distribution';

export const POST = route({ perm: 'distribution.create', body: planInput, rate: { bucket: 'dist-preview', limit: 120, windowSec: 60 } }, async ({ body }) => previewDistribution(body));
