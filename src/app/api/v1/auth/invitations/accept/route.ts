import { z } from 'zod';
import { route } from '@/server/api';
import { acceptInvitation } from '@/server/services/auth';
import { deliverWelcomeLeads } from '@/server/services/onboarding';

export const POST = route(
  {
    auth: 'public',
    body: z.object({ token: z.string().min(20).max(200), name: z.string().trim().min(2).max(120), password: z.string().min(1).max(256) }),
    rate: { bucket: 'invite-accept', limit: 10, windowSec: 900, by: 'ip' },
  },
  async ({ body, meta }) => {
    const user = await acceptInvitation(body.token, { name: body.name, password: body.password }, meta);
    // New businesses from an application get their free leads from what they searched for, ready on first sign-in.
    const welcome = await deliverWelcomeLeads(user.id).catch(() => null);
    return { ok: true, welcomeLeads: welcome ? { count: welcome.deliveredCount || welcome.leadCount, status: welcome.status } : null };
  },
);
