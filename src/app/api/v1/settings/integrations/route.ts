import { z } from 'zod';
import { route } from '@/server/api';
import { integrationStatus, INTEGRATIONS, setIntegrationEnabled } from '@/server/services/governance';

export const GET = route({ perm: 'system.manage' }, async () => ({ integrations: await integrationStatus() }));
export const PUT = route(
  { perm: 'system.manage', body: z.object({ provider: z.enum(Object.keys(INTEGRATIONS) as [keyof typeof INTEGRATIONS]), enabled: z.boolean() }) },
  async ({ ctx, body }) => {
    await setIntegrationEnabled(ctx, body.provider, body.enabled);
    return { integrations: await integrationStatus() };
  },
);
