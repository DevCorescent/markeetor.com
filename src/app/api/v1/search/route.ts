import { z } from 'zod';
import { route } from '@/server/api';
import { can } from '@/server/auth/context';
import { prisma, withPlatform, withTenant } from '@/server/db';

export const GET = route(
  { scope: 'ANY', selfService: true, query: z.object({ q: z.string().trim().min(2).max(100) }), rate: { bucket: 'search', limit: 120, windowSec: 60 } },
  async ({ ctx, query }) => {
    const q = query.q;
    const results: { type: string; id: string; title: string; subtitle?: string; href: string }[] = [];
    if (ctx.scope === 'PLATFORM') {
      if (can(ctx, 'leads.read')) {
        const leads = await withPlatform((tx) =>
          tx.lead.findMany({
            where: { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { company: { contains: q, mode: 'insensitive' } }, { emailNormalized: { startsWith: q.toLowerCase() } }, { phoneNormalized: { contains: q.replace(/[^\d+]/g, '') || '∅' } }] },
            take: 8, orderBy: { updatedAt: 'desc' }, select: { id: true, fullName: true, company: true, allocationStatus: true },
          }),
        );
        leads.forEach((l) => results.push({ type: 'lead', id: l.id, title: l.fullName, subtitle: [l.company, l.allocationStatus.toLowerCase()].filter(Boolean).join(' · '), href: `/admin/leads/${l.id}` }));
      }
      if (can(ctx, 'orgs.read')) {
        const orgs = await prisma.organization.findMany({ where: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] }, take: 5 });
        orgs.forEach((o) => results.push({ type: 'org', id: o.id, title: o.name, subtitle: `${o.code} · ${o.status.toLowerCase()}`, href: `/admin/organizations/${o.id}` }));
      }
      if (can(ctx, 'users.read')) {
        const users = await prisma.user.findMany({ where: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q.toLowerCase() } }] }, take: 5 });
        users.forEach((u) => results.push({ type: 'user', id: u.id, title: u.name, subtitle: u.email, href: `/admin/users/${u.id}` }));
      }
    } else {
      const own = !can(ctx, 'crm.leads.read_all');
      if (can(ctx, 'crm.leads.read_all', 'crm.leads.read_own')) {
        const leads = await withTenant(ctx.orgId!, (tx) =>
          tx.clientLead.findMany({
            where: {
              organizationId: ctx.orgId!, revokedAt: null, ...(own ? { ownerId: ctx.user.id } : {}),
              OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { company: { contains: q, mode: 'insensitive' } }],
            },
            take: 10, orderBy: { updatedAt: 'desc' }, select: { id: true, fullName: true, company: true, status: true },
          }),
        );
        leads.forEach((l) => results.push({ type: 'lead', id: l.id, title: l.fullName, subtitle: [l.company, l.status.toLowerCase()].filter(Boolean).join(' · '), href: `/app/leads/${l.id}` }));
      }
    }
    return { results };
  },
);
