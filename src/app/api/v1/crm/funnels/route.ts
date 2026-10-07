import { route } from '@/server/api';
import { funnelInput, listFunnels, saveFunnel } from '@/server/services/funnels';
import { assertFunnels } from './guard';

const VIEW = ['crm.funnels.manage', 'crm.leads.read_all'] as const;
export const GET = route({ scope: 'ORGANIZATION', perm: [...VIEW] }, async ({ ctx }) => { assertFunnels(ctx); return { funnels: await listFunnels(ctx) }; });
export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.funnels.manage', body: funnelInput }, async ({ ctx, body }) => { assertFunnels(ctx); return saveFunnel(ctx, null, body); });
