import { route } from '@/server/api';
import { prisma } from '@/server/db';
import { clientSettingsInput, updateClientSettings } from '@/server/services/crm';
import { orgSettings } from '@/server/services/organizations';

export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.settings.manage' }, async ({ ctx }) => {
  const o = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId! }, select: { name: true, code: true, contactEmail: true, contactPhone: true, address: true, timezone: true, settings: true, logoKey: true, legalName: true, gstin: true, billingState: true } });
  const s = orgSettings(o.settings);
  return { profile: { ...o, settings: undefined, hasLogo: Boolean(o.logoKey) }, settings: s, platformLocks: (o.settings as { platformLocks?: object }).platformLocks ?? {} };
});
export const PUT = route({ scope: 'ORGANIZATION', perm: 'crm.settings.manage', body: clientSettingsInput }, async ({ ctx, body }) => updateClientSettings(ctx, body));
