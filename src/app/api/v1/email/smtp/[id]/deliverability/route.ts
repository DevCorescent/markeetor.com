import { idParam, route } from '@/server/api';
import { checkSender } from '@/server/services/deliverability';

/** Runs the SPF / DKIM / DMARC / MX / link checks for a sender's domain (DNS lookups only, nothing is sent). */
export const POST = route({ scope: 'ANY', perm: ['email.manage', 'crm.email.manage'], rate: { bucket: 'deliverability-check', limit: 60, windowSec: 3600 } }, async ({ ctx, params }) => checkSender(ctx, idParam(params)));
