import { route } from '@/server/api';
import { finderInput, finderTurn } from '@/server/services/lead-finder';

/** One turn of the Lead Finder conversation. Stateless: the client sends the criteria and recent history. */
export const POST = route(
  { scope: 'ORGANIZATION', perm: 'crm.marketplace.view', body: finderInput, rate: { bucket: 'lead-finder', limit: 60, windowSec: 60 } },
  async ({ ctx, body }) => finderTurn(ctx, body),
);
