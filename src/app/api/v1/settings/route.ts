import { z } from 'zod';
import { route } from '@/server/api';
import { assertCan } from '@/server/auth/context';
import { allSettings, settingSchemas, updateSetting, type EditableSetting } from '@/server/services/governance';

export const GET = route({ perm: ['system.manage', 'security.manage', 'audit.admin'] }, async () => ({ settings: await allSettings() }));

export const PUT = route(
  { perm: ['system.manage', 'security.manage', 'audit.admin'], stepUp: true, body: z.object({ key: z.enum(Object.keys(settingSchemas) as [EditableSetting]), value: z.record(z.string(), z.unknown()) }) },
  async ({ ctx, body }) => {
    // Security policy is editable by security admins; audit retention by audit admins; the rest by system managers.
    if (body.key === 'security.policy') assertCan(ctx, 'security.manage', 'system.manage');
    else if (body.key === 'audit.retention') assertCan(ctx, 'audit.admin');
    else assertCan(ctx, 'system.manage');
    return { value: await updateSetting(ctx, body.key, body.value) };
  },
);
